import { generateImage, generateVideo } from "./media.js";
import {
  answerWithSources, bytesToBase64, extractPdfPages, findProject, latestDigest, notionDigest, projectDocuments,
  projectHistory, projectRoute, requestError, saveProjectAnswer, webSources, workspaceSchema,
} from "./workspace.js";
import { notionReadOnly } from "./notion-read.js";

const CORS_BASE = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

const TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const NEMOTRON_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const PLAN_LIMITS = {
  free: {
    chat: { limit: 15, period: "day" }, cv: { limit: 3, period: "month" },
    job: { limit: 5, period: "month" }, interview: { limit: 5, period: "month" },
    file: { limit: 3, period: "month" }, image: { limit: 10, period: "month" },
    image_edit: { limit: 5, period: "month" }, code: { limit: 5, period: "month" },
    website: { limit: 0, period: "month" }, app: { limit: 0, period: "month" },
    cad: { limit: 0, period: "month" },
  },
  ai_pro: {
    chat: { limit: 300, period: "month" }, cv: { limit: 30, period: "month" },
    job: { limit: 50, period: "month" }, interview: { limit: 50, period: "month" },
    file: { limit: 40, period: "month" }, image: { limit: 60, period: "month" },
    image_edit: { limit: 30, period: "month" }, code: { limit: 30, period: "month" },
    website: { limit: 0, period: "month" }, app: { limit: 0, period: "month" },
    cad: { limit: 0, period: "month" },
  },
  builder: {
    chat: { limit: 800, period: "month" }, cv: { limit: 100, period: "month" },
    job: { limit: 150, period: "month" }, interview: { limit: 150, period: "month" },
    file: { limit: 100, period: "month" }, image: { limit: 150, period: "month" },
    image_edit: { limit: 80, period: "month" }, code: { limit: 200, period: "month" },
    website: { limit: 30, period: "month" }, app: { limit: 20, period: "month" },
    cad: { limit: 0, period: "month" },
  },
  engineering: {
    chat: { limit: 1200, period: "month" }, cv: { limit: 150, period: "month" },
    job: { limit: 200, period: "month" }, interview: { limit: 200, period: "month" },
    file: { limit: 150, period: "month" }, image: { limit: 250, period: "month" },
    image_edit: { limit: 120, period: "month" }, code: { limit: 300, period: "month" },
    website: { limit: 50, period: "month" }, app: { limit: 30, period: "month" },
    cad: { limit: 60, period: "month" },
  },
};

const PLAN_LABELS = { free: "Free", ai_pro: "AI Pro", builder: "Builder Pro", engineering: "Engineering Pro" };
const PLAN_PRICES = {
  ai_pro: { kwd: 3, usd: 8 },
  builder: { kwd: 5, usd: 15 },
  engineering: { kwd: 7, usd: 22 },
};

let schemaPromise = null;

function cors(request) {
  const origin = request.headers.get("Origin") || "*";
  return { ...CORS_BASE, "Access-Control-Allow-Origin": origin };
}
function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(request), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function now() { return Date.now(); }
function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }
function lower(v) { return String(v || "").toLowerCase(); }
function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function safeJson(v) { try { return JSON.stringify(v); } catch { return "{}"; } }
function planLabel(v) { return PLAN_LABELS[v] || PLAN_LABELS.free; }
function isPaidPlan(v) { return !!PLAN_PRICES[v]; }

function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64Bytes(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function hmacBase64(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return base64Bytes(sig);
}
function constantTimeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function derivePassword(env, password, saltB64) {
  // IMPORTANT: keep ADMIN_KEY stable. It is a server-side pepper for existing passwords.
  if (!env.ADMIN_KEY) throw new Error("ADMIN_KEY secret is missing.");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ADMIN_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const data = new TextEncoder().encode(`${saltB64}\0${password}`);
  return hex(await crypto.subtle.sign("HMAC", key, data));
}
async function createPassword(env, password) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const saltB64 = base64Bytes(salt);
  return { salt: saltB64, hash: await derivePassword(env, password, saltB64) };
}

async function ensureSchema(env) {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        video_credits INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage_counters(
        user_id TEXT NOT NULL,
        period_key TEXT NOT NULL,
        metric TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,period_key,metric)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS chat_messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_accounts(
        user_id TEXT PRIMARY KEY,
        auth_provider TEXT NOT NULL DEFAULT 'email',
        google_sub TEXT UNIQUE,
        display_name TEXT,
        picture_url TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_login_at INTEGER,
        updated_at INTEGER NOT NULL,
        subscription_started_at INTEGER,
        subscription_ends_at INTEGER,
        admin_note TEXT
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS payments(
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'KWD',
        provider TEXT NOT NULL DEFAULT 'myfatoorah',
        provider_invoice_id TEXT UNIQUE,
        provider_payment_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        paid_at INTEGER,
        subscription_ends_at INTEGER,
        provider_status TEXT,
        raw_status TEXT
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_rate(
        rate_key TEXT NOT NULL,
        window_key TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(rate_key,window_key)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT,
        action TEXT NOT NULL,
        target_user_id TEXT,
        details TEXT,
        created_at INTEGER NOT NULL
      )`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id,id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id,created_at)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(provider_invoice_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_accounts_status ON user_accounts(status)"),
      ...workspaceSchema.map(sql => env.DB.prepare(sql)),
    ]);
  })().catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}

async function ensureAccount(env, userId, provider = "email", extra = {}) {
  const t = now();
  await env.DB.prepare(`INSERT OR IGNORE INTO user_accounts(user_id,auth_provider,status,updated_at,last_login_at)
    VALUES(?,?,?,?,?)`).bind(userId, provider, "active", t, t).run();
  const sets = [], vals = [];
  for (const [col, val] of Object.entries(extra)) {
    if (!["auth_provider","google_sub","display_name","picture_url","last_login_at","subscription_started_at","subscription_ends_at","admin_note"].includes(col)) continue;
    if (val === undefined) continue;
    sets.push(`${col}=?`); vals.push(val);
  }
  if (sets.length) {
    sets.push("updated_at=?"); vals.push(t, userId);
    await env.DB.prepare(`UPDATE user_accounts SET ${sets.join(",")} WHERE user_id=?`).bind(...vals).run();
  }
}
function ownerEmail(env) { return normalizeEmail(env.OWNER_EMAIL || ""); }
function isAdminUser(env, user) { return !!user && !!ownerEmail(env) && normalizeEmail(user.email) === ownerEmail(env); }

async function audit(env, actorId, action, targetId = null, details = null) {
  await env.DB.prepare("INSERT INTO audit_events(actor_user_id,action,target_user_id,details,created_at) VALUES(?,?,?,?,?)")
    .bind(actorId || null, action, targetId || null, details ? safeJson(details).slice(0, 8000) : null, now()).run();
}

function hourWindow() { return Math.floor(now() / 3600000).toString(); }
async function enforceAuthRate(request, env, kind, limit) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const pepper = env.ADMIN_KEY || "datacore";
  const key = await sha256(`${pepper}\0${kind}\0${ip}`);
  const win = hourWindow();
  const row = await env.DB.prepare("SELECT count FROM auth_rate WHERE rate_key=? AND window_key=?").bind(key, win).first();
  if (Number(row?.count || 0) >= limit) return false;
  await env.DB.prepare(`INSERT INTO auth_rate(rate_key,window_key,count) VALUES(?,?,1)
    ON CONFLICT(rate_key,window_key) DO UPDATE SET count=count+1`).bind(key, win).run();
  return true;
}

function periodKey(period) {
  const d = new Date(); const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return period === "day" ? `${y}-${m}-${day}` : `${y}-${m}`;
}
async function createSession(env, userId) {
  const token = randomToken(32), tokenHash = await sha256(token), created = now(), expires = created + THIRTY_DAYS;
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
    .bind(tokenHash, userId, expires, created).run();
  return token;
}
async function deleteSession(request, env) {
  const auth = request.headers.get("Authorization") || ""; const m = auth.match(/^Bearer\s+(.+)$/i); if (!m) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(m[1])).run();
}
async function authUser(request, env) {
  const auth = request.headers.get("Authorization") || ""; const m = auth.match(/^Bearer\s+(.+)$/i); if (!m) return null;
  const tokenHash = await sha256(m[1]);
  let row = await env.DB.prepare(`SELECT u.id,u.email,u.plan,u.video_credits,u.created_at,
      COALESCE(a.status,'active') AS status,a.auth_provider,a.google_sub,a.display_name,a.picture_url,
      a.last_login_at,a.subscription_started_at,a.subscription_ends_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN user_accounts a ON a.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(tokenHash, now()).first();
  if (!row) return null;
  if (!row.auth_provider) {
    await ensureAccount(env, row.id, "email", { last_login_at: now() });
    row = await env.DB.prepare(`SELECT u.id,u.email,u.plan,u.video_credits,u.created_at,
      COALESCE(a.status,'active') AS status,a.auth_provider,a.google_sub,a.display_name,a.picture_url,
      a.last_login_at,a.subscription_started_at,a.subscription_ends_at
      FROM users u LEFT JOIN user_accounts a ON a.user_id=u.id WHERE u.id=?`).bind(row.id).first();
  }
  if (!isAdminUser(env, row) && row.plan !== "free" && row.subscription_ends_at && Number(row.subscription_ends_at) <= now()) {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET plan='free' WHERE id=?").bind(row.id),
      env.DB.prepare("UPDATE user_accounts SET subscription_started_at=NULL,subscription_ends_at=NULL,updated_at=? WHERE user_id=?").bind(now(), row.id),
    ]);
    row.plan = "free"; row.subscription_started_at = null; row.subscription_ends_at = null;
  }
  row.is_admin = isAdminUser(env, row);
  row.owner_unlimited = row.is_admin;
  return row;
}
async function requireUser(request, env) {
  const u = await authUser(request, env);
  if (!u) return { error: json(request, { ok: false, error: "Please sign in first.", code: "AUTH_REQUIRED" }, 401) };
  if (u.status === "suspended") return { error: json(request, { ok: false, error: "This account is suspended. Contact support.", code: "ACCOUNT_SUSPENDED" }, 403) };
  return { user: u };
}
async function requireAdmin(request, env) {
  const a = await requireUser(request, env); if (a.error) return a;
  if (!a.user.is_admin) return { error: json(request, { ok: false, error: "Admin access required." }, 403) };
  return a;
}
async function usageCount(env, userId, metric, period) {
  const key = periodKey(period);
  const row = await env.DB.prepare("SELECT count FROM usage_counters WHERE user_id=? AND period_key=? AND metric=?")
    .bind(userId, key, metric).first();
  return { key, count: Number(row?.count || 0) };
}
async function usageSummary(env, user) {
  const plan = PLAN_LIMITS[user.plan] ? user.plan : "free"; const limits = PLAN_LIMITS[plan], out = {};
  for (const [metric, spec] of Object.entries(limits)) {
    const u = await usageCount(env, user.id, metric, spec.period);
    out[metric] = isAdminUser(env, user) ? { used: u.count, limit: null, period: "unlimited", unlimited: true } : { used: u.count, limit: spec.limit, period: spec.period };
  }
  return out;
}
async function checkLimit(env, user, metric) {
  // Trusted server-side owner identity only: never accept a client-provided admin flag.
  if (isAdminUser(env, user)) return { ok: true, owner_unlimited: true };
  if (metric === "video") {
    if (Number(user.video_credits || 0) <= 0) return { ok: false, code: "VIDEO_CREDITS_REQUIRED", message: "Video generation requires video credits." };
    return { ok: true, video: true };
  }
  const plan = PLAN_LIMITS[user.plan] ? user.plan : "free";
  const spec = PLAN_LIMITS[plan][metric] || PLAN_LIMITS[plan].chat;
  if (spec.limit === 0) return { ok: false, code: "UPGRADE_REQUIRED", message: `${PLAN_LABELS[plan]} does not include this tool. Please upgrade your plan.` };
  const u = await usageCount(env, user.id, metric, spec.period);
  if (u.count >= spec.limit) return { ok: false, code: "LIMIT_REACHED", message: `${metric.replace(/_/g, " ")} limit reached for this ${spec.period}.` };
  return { ok: true, spec };
}
async function storeMessage(env, userId, role, kind, content) {
  const safe = String(content || "").slice(0, 24000); if (!safe) return;
  await env.DB.prepare("INSERT INTO chat_messages(user_id,role,kind,content,created_at) VALUES(?,?,?,?,?)")
    .bind(userId, role, kind, safe, now()).run();
}

function isImage(file) {
  if (!file) return false; const t = lower(file.type), n = lower(file.name);
  return t.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/.test(n);
}
function isPlainText(file) {
  if (!file) return false; const t = lower(file.type), n = lower(file.name);
  return t.startsWith("text/") || /\.(txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|scss|py|java|kt|xml|yaml|yml|toml|ini|sql|sh|ps1|c|cpp|h|hpp|go|rs|php|rb|swift|dart|scr|lsp|scad|dxf)$/.test(n);
}
function detectIntent(prompt, file) {
  const p = lower(prompt), hasFile = !!file, img = isImage(file);
  const videoWords = /\b(video|animate|animation|image to video|text to video|make .* move|camera orbit|orbit camera|camera move|motion|cinematic clip|short clip)\b/;
  if (hasFile && img && videoWords.test(p)) return "video_i2v";
  if (!hasFile && videoWords.test(p) && /\b(create|generate|make|text to video|video)\b/.test(p)) return "video_t2v";
  if (/\b(autocad|auto cad|cad|3d diagram|3d model|3d drawing|piping isometric|isometric drawing|pipe routing|pipeline layout|equipment layout|plant layout|oil and gas|oil & gas|p&id|pid drawing|civil drawing|structural drawing|mechanical layout)\b/.test(p)) return "cad";
  const imageEdit = /\b(edit|change|replace|remove|add|modify|transform|enhance|retouch|upscale|background|dress|shirt|hair|lighting|cinematic|make this|turn this|keep .* face|keep .* subject)\b/.test(p);
  const imageAnalyze = /\b(what is|what's|describe|analy[sz]e|explain|identify|read|tell me about|what do you see|extract text|ocr)\b/.test(p);
  const imageCreate = /\b(generate|create|make|draw|render|design)\b.*\b(image|photo|picture|poster|logo|illustration|art|wallpaper|drone view|aerial view)\b|\b(text\s*to\s*image|image generation|drone view|aerial view)\b/.test(p);
  if (hasFile && img) { if (imageAnalyze && !imageEdit) return "image_analysis"; return "image_edit"; }
  if (!hasFile && imageCreate) return "image_generate";
  if (/\b(build|create|make|design|generate)\b.*\b(website|web site|landing page|webpage|web page)\b|\bwebsite builder\b/.test(p)) return "website";
  if (/\b(build|create|make|design|generate)\b.*\b(android app|mobile app|ios app|app|application)\b|\bapp builder\b/.test(p)) return "app";
  if (/\b(code|coding|program|script|debug|html|css|javascript|typescript|python|java|kotlin|flutter|react native|sql)\b/.test(p)) return "code";
  if (/\b(cv|resume|curriculum vitae|ats resume)\b/.test(p)) return "cv";
  if (/\b(interview|job match|job-match|match my cv|match my resume)\b/.test(p)) return "interview";
  if (/\b(job application|cover letter|vacancy|job description|application email)\b/.test(p)) return "job";
  if (/\b(excel|spreadsheet|formula|csv|worksheet|workbook|pivot|vlookup|xlookup)\b/.test(p)) return "excel";
  if (/\b(document control|transmittal|wir|itp|mir|ncr|method statement|document register|revision register|correspondence register)\b/.test(p)) return "document_control";
  if (/\b(letter|report|memo|minutes|sop|policy|quotation|invoice|office document|business document|form|checklist)\b/.test(p)) return "office";
  if (hasFile) return "file_analysis";
  return "chat";
}
function metricFor(intent, file) {
  if (["video_i2v","video_t2v"].includes(intent)) return "video";
  if (intent === "image_generate") return "image"; if (intent === "image_edit") return "image_edit";
  if (["cv","job","interview","website","app","code","cad"].includes(intent)) return intent;
  if (file) return "file"; return "chat";
}
function systemFor(intent) {
  const base = "You are NibrasGPT. Be accurate, practical and professional. Never invent user facts.";
  const map = {
    chat: `${base} Answer the user's request directly.`,
    cv: `${base} You are an ATS CV/Resume specialist for all industries. Use only supplied facts. Mark missing critical information as [Add details]. Use clear headings and strong concise bullet points.`,
    job: `${base} Help with job applications, cover letters and job-description matching. Never invent qualifications or employment history.`,
    interview: `${base} Prepare realistic interview questions, strong sample answers and job-match analysis using only the user's supplied background.`,
    excel: `${base} You are an Excel/spreadsheet specialist. Give exact formulas when possible and practical data-cleaning/analysis steps.`,
    document_control: `${base} You are a Document Control specialist for engineering, construction, oil & gas and general business. Help with registers, transmittals, revisions, status tracking, correspondence, WIR, ITP, MIR, NCR, method statements and project document workflows.`,
    office: `${base} Create professional letters, reports, SOPs, memos, minutes, quotations, invoices, policies, forms and checklists.`,
    code: `${base} You are a coding assistant. Produce correct runnable code when practical and clearly separate files/code blocks.`,
    website: `${base} You are a website builder. Prefer a complete responsive single-file HTML solution with embedded CSS and JavaScript unless the user asks for another stack. Put the complete deliverable in a fenced html code block.`,
    app: `${base} You are an app builder. Generate a complete app source structure and code. For Android, prefer Kotlin when not specified. Explain that APK/IPA compilation and signing is a separate build step.`,
    cad: `${base} You are an Engineering CAD Assistant for conceptual and drafting support in oil & gas, piping, pipelines, construction, civil, structural, mechanical and equipment layouts. For AutoCAD 3D or piping work, use supplied dimensions; if critical dimensions are missing, clearly list assumptions or request the missing data. Include drawing purpose, units, coordinate system, equipment list, dimensions/assumptions, layer suggestions, drafting sequence, and an AutoCAD-compatible .SCR or AutoLISP block when feasible. Never claim conceptual output is construction-approved. State that a qualified engineer must verify and approve the final drawing against project codes and site conditions.`,
    file_analysis: `${base} Analyze only the supplied file content. Do not claim facts not present in the file.`,
    image_analysis: `${base} Analyze only the uploaded image information and answer the user's question directly.`,
  };
  return map[intent] || map.chat;
}
async function runText(env, system, prompt, model) {
  const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
  if (model !== "nemotron") {
    const result = await env.AI.run(TEXT_MODEL, { messages, max_tokens: 3000, temperature: 0.25 });
    return result?.response || "";
  }
  const key = String(env.NVIDIA_API_KEY || "").trim();
  if (!key) throw requestError("NVIDIA Nemotron has not been configured.", 503, "NEMOTRON_NOT_CONFIGURED");
  let response;
  try {
    response = await fetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: NEMOTRON_MODEL, messages, max_tokens: 3000, temperature: 0.25, stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw requestError("NVIDIA Nemotron is temporarily unavailable. Please retry or select the default model.", 502, "NEMOTRON_UNAVAILABLE");
  }
  if (response.status === 429) throw requestError("NVIDIA Nemotron is busy. Please retry shortly.", 429, "NEMOTRON_RATE_LIMIT");
  if (!response.ok) throw requestError("NVIDIA Nemotron could not complete the request. Please retry or select the default model.", 502, "NEMOTRON_UNAVAILABLE");
  const result = await response.json().catch(() => null);
  const reply = result?.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) throw requestError("NVIDIA Nemotron returned no answer. Please retry.", 502, "NEMOTRON_EMPTY");
  return reply;
}
async function convertFile(env, file) {
  if (isPlainText(file)) return (await file.text()).slice(0, 100000);
  const r = await env.AI.toMarkdown({ name: file.name || "upload", blob: new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }) },
    { conversionOptions: { output: { format: "markdown" }, pdf: { metadata: false }, image: { descriptionLanguage: "en" } } });
  const item = Array.isArray(r) ? r[0] : r;
  if (!item || item.format === "error") throw new Error(item?.error || "Could not read the uploaded file.");
  return String(item.data || "").slice(0, 100000);
}
function artifactFor(intent) {
  if (intent === "website") return { kind: "website", name: "index.html", lang: "html" };
  if (intent === "app") return { kind: "app", name: "datacore-app-source.txt", lang: "" };
  if (intent === "code") return { kind: "code", name: "datacore-code.txt", lang: "" };
  if (intent === "cad") return { kind: "cad", name: "datacore-engineering.scr", lang: "scr" };
  if (intent === "cv") return { kind: "cv", name: "datacore-cv.txt", lang: "" };
  return null;
}
async function handleSignup(request, env) {
  if (!(await enforceAuthRate(request, env, "signup", 10))) return json(request, { ok: false, error: "Too many signup attempts. Try again later." }, 429);
  const b = await request.json(), email = normalizeEmail(b.email), password = String(b.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(request, { ok: false, error: "Enter a valid email." }, 400);
  if (password.length < 8) return json(request, { ok: false, error: "Password must be at least 8 characters." }, 400);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  if (existing) return json(request, { ok: false, error: "An account with this email already exists." }, 409);
  const id = crypto.randomUUID(), p = await createPassword(env, password), t = now();
  await env.DB.prepare("INSERT INTO users(id,email,password_hash,password_salt,plan,video_credits,created_at) VALUES(?,?,?,?,?,?,?)")
    .bind(id, email, p.hash, p.salt, "free", 0, t).run();
  await ensureAccount(env, id, "email", { last_login_at: t });
  const token = await createSession(env, id);
  await audit(env, id, "account.signup", id, { provider: "email" });
  return json(request, { ok: true, token, user: { id, email, plan: "free", video_credits: 0, auth_provider: "email", status: "active", is_admin: isAdminUser(env, { email }) } });
}
async function handleLogin(request, env) {
  if (!(await enforceAuthRate(request, env, "login", 30))) return json(request, { ok: false, error: "Too many login attempts. Try again later." }, 429);
  const b = await request.json(), email = normalizeEmail(b.email), password = String(b.password || "");
  const u = await env.DB.prepare(`SELECT u.id,u.email,u.password_hash,u.password_salt,u.plan,u.video_credits,u.created_at,
    COALESCE(a.status,'active') AS status,a.auth_provider,a.subscription_ends_at FROM users u LEFT JOIN user_accounts a ON a.user_id=u.id WHERE u.email=?`).bind(email).first();
  if (!u) return json(request, { ok: false, error: "Invalid email or password." }, 401);
  if (u.status === "suspended") return json(request, { ok: false, error: "This account is suspended. Contact support." }, 403);
  const h = await derivePassword(env, password, u.password_salt);
  if (h !== u.password_hash) return json(request, { ok: false, error: "Invalid email or password." }, 401);
  await ensureAccount(env, u.id, u.auth_provider || "email", { last_login_at: now() });
  const token = await createSession(env, u.id);
  return json(request, { ok: true, token, user: { id: u.id, email: u.email, plan: u.plan, video_credits: u.video_credits, status: u.status, auth_provider: u.auth_provider || "email", is_admin: isAdminUser(env, u), owner_unlimited: isAdminUser(env, u) } });
}
async function verifyGoogleCredential(env, credential) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error("Google sign-in is not configured yet.");
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!r.ok) throw new Error("Google sign-in verification failed.");
  const d = await r.json();
  if (String(d.aud || "") !== String(env.GOOGLE_CLIENT_ID)) throw new Error("Google token audience mismatch.");
  if (!d.email || String(d.email_verified) !== "true") throw new Error("Google email is not verified.");
  return d;
}
async function handleGoogleAuth(request, env) {
  if (!(await enforceAuthRate(request, env, "google", 30))) return json(request, { ok: false, error: "Too many login attempts. Try again later." }, 429);
  const b = await request.json(); const g = await verifyGoogleCredential(env, String(b.credential || ""));
  const email = normalizeEmail(g.email), sub = String(g.sub || ""); if (!email || !sub) throw new Error("Google account information is incomplete.");
  let u = await env.DB.prepare("SELECT id,email,plan,video_credits,created_at FROM users WHERE email=?").bind(email).first();
  const t = now();
  if (!u) {
    const id = crypto.randomUUID(), salt = randomToken(12);
    await env.DB.prepare("INSERT INTO users(id,email,password_hash,password_salt,plan,video_credits,created_at) VALUES(?,?,?,?,?,?,?)")
      .bind(id, email, "GOOGLE_ONLY", salt, "free", 0, t).run();
    await ensureAccount(env, id, "google", { google_sub: sub, display_name: g.name || null, picture_url: g.picture || null, last_login_at: t });
    u = { id, email, plan: "free", video_credits: 0, created_at: t };
    await audit(env, id, "account.signup", id, { provider: "google" });
  } else {
    const a = await env.DB.prepare("SELECT status,auth_provider,google_sub FROM user_accounts WHERE user_id=?").bind(u.id).first();
    if (a?.status === "suspended") return json(request, { ok: false, error: "This account is suspended. Contact support." }, 403);
    if (a?.google_sub && a.google_sub !== sub) return json(request, { ok: false, error: "This email is linked to a different Google identity." }, 409);
    const provider = !a ? "email+google" : (a.auth_provider === "email" ? "email+google" : (a.auth_provider || "google"));
    await ensureAccount(env, u.id, provider, { auth_provider: provider, google_sub: sub, display_name: g.name || null, picture_url: g.picture || null, last_login_at: t });
  }
  const token = await createSession(env, u.id);
  const account = await env.DB.prepare("SELECT status,auth_provider,display_name,picture_url,subscription_ends_at FROM user_accounts WHERE user_id=?").bind(u.id).first();
  return json(request, { ok: true, token, user: { ...u, ...account, is_admin: isAdminUser(env, u), owner_unlimited: isAdminUser(env, u) } });
}

function myFatoorahBase(env) { return String(env.MYFATOORAH_MODE || "test").toLowerCase() === "live" ? "https://api.myfatoorah.com" : "https://apitest.myfatoorah.com"; }
function appUrl(env) { return String(env.PUBLIC_APP_URL || "https://rahmankhanrm1-cloud.github.io/datacore-ai/").replace(/\?+$/, ""); }
async function mfRequest(env, path, options = {}) {
  if (!env.MYFATOORAH_API_KEY) throw new Error("Payments are not configured yet.");
  const headers = new Headers(options.headers || {}); headers.set("Authorization", `Bearer ${env.MYFATOORAH_API_KEY}`); headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const r = await fetch(myFatoorahBase(env) + path, { ...options, headers });
  let d = null; try { d = await r.json(); } catch { d = null; }
  if (!r.ok || d?.IsSuccess === false) {
    const msg = d?.Message || d?.ErrorMessage || d?.ValidationErrors?.map(x => x.Error || x.Message).filter(Boolean).join("; ") || `Payment provider error (${r.status}).`;
    throw new Error(msg);
  }
  return d;
}
async function activatePaidPayment(env, payment, providerData) {
  if (!payment) throw new Error("Payment record not found.");
  if (payment.status === "paid") return payment;
  const u = await env.DB.prepare("SELECT id,email,plan FROM users WHERE id=?").bind(payment.user_id).first();
  if (!u) throw new Error("Payment user not found.");
  const a = await env.DB.prepare("SELECT subscription_ends_at FROM user_accounts WHERE user_id=?").bind(u.id).first();
  const t = now();
  let end = t + THIRTY_DAYS;
  if (u.plan === payment.plan && Number(a?.subscription_ends_at || 0) > t) end = Number(a.subscription_ends_at) + THIRTY_DAYS;
  const providerPaymentId = providerData?.Data?.Transaction?.PaymentId || providerData?.provider_payment_id || payment.provider_payment_id || null;
  await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status='paid',provider_payment_id=COALESCE(?,provider_payment_id),updated_at=?,paid_at=?,subscription_ends_at=?,provider_status='SUCCESS',raw_status=? WHERE id=?")
      .bind(providerPaymentId, t, t, end, safeJson(providerData).slice(0, 12000), payment.id),
    env.DB.prepare("UPDATE users SET plan=? WHERE id=?").bind(payment.plan, u.id),
    env.DB.prepare("UPDATE user_accounts SET subscription_started_at=?,subscription_ends_at=?,updated_at=? WHERE user_id=?").bind(t, end, t, u.id),
  ]);
  await audit(env, null, "payment.paid", u.id, { payment_id: payment.id, plan: payment.plan, amount: payment.amount, currency: payment.currency });
  return await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(payment.id).first();
}
async function updatePaymentFromProvider(env, payment, data) {
  const invoiceStatus = String(data?.Data?.Invoice?.Status || "").toUpperCase();
  const txnStatus = String(data?.Data?.Transaction?.Status || "").toUpperCase();
  const providerPaymentId = data?.Data?.Transaction?.PaymentId || payment.provider_payment_id || null;
  if (invoiceStatus === "PAID" && txnStatus === "SUCCESS") return await activatePaidPayment(env, payment, data);
  const failed = ["FAILED","CANCELED","CANCELLED"].includes(txnStatus);
  const status = failed ? "failed" : "pending";
  await env.DB.prepare("UPDATE payments SET status=?,provider_payment_id=COALESCE(?,provider_payment_id),provider_status=?,updated_at=?,raw_status=? WHERE id=?")
    .bind(status, providerPaymentId, txnStatus || invoiceStatus || null, now(), safeJson(data).slice(0, 12000), payment.id).run();
  return await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(payment.id).first();
}
async function handleCreatePayment(request, env, user) {
  if (isAdminUser(env, user)) return json(request, { ok: false, code: "OWNER_NO_PAYMENT", error: "Owner access is unlimited; no subscription purchase is needed." }, 403);
  if (!env.MYFATOORAH_API_KEY) return json(request, { ok: false, error: "Payments are not enabled yet. Merchant setup is still required.", code: "PAYMENT_NOT_CONFIGURED" }, 503);
  const b = await request.json(), plan = String(b.plan || "");
  if (!PLAN_PRICES[plan]) return json(request, { ok: false, error: "Choose a paid plan." }, 400);
  const amount = PLAN_PRICES[plan].kwd, id = crypto.randomUUID(), redirect = `${appUrl(env)}?payment=return`;
  const payload = { Order: { Amount: amount }, IntegrationUrls: { Redirection: redirect }, Language: "EN", OperationType: "PAY" };
  const d = await mfRequest(env, "/v3/payments", { method: "POST", body: JSON.stringify(payload) });
  const invoiceId = String(d?.Data?.InvoiceId || ""), paymentUrl = d?.Data?.PaymentURL;
  if (!invoiceId || !paymentUrl) throw new Error("Payment provider did not return an invoice URL.");
  const t = now();
  await env.DB.prepare(`INSERT INTO payments(id,user_id,plan,amount,currency,provider,provider_invoice_id,status,created_at,updated_at,provider_status,raw_status)
    VALUES(?,?,?,?,?,'myfatoorah',?,'pending',?,?,?,?)`)
    .bind(id, user.id, plan, amount, "KWD", invoiceId, t, t, "CREATED", safeJson(d).slice(0, 12000)).run();
  await audit(env, user.id, "payment.created", user.id, { payment_id: id, invoice_id: invoiceId, plan, amount });
  return json(request, { ok: true, payment_id: id, invoice_id: invoiceId, payment_url: paymentUrl, plan, amount, currency: "KWD" });
}
async function handleVerifyPayment(request, env, user) {
  const b = await request.json(), paymentId = String(b.paymentId || "").trim();
  if (!paymentId) return json(request, { ok: false, error: "Missing paymentId." }, 400);
  const d = await mfRequest(env, `/v3/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
  const invoiceId = String(d?.Data?.Invoice?.Id || "");
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE provider_invoice_id=?").bind(invoiceId).first();
  if (!payment || payment.user_id !== user.id) return json(request, { ok: false, error: "Payment record not found for this account." }, 404);
  const updated = await updatePaymentFromProvider(env, payment, d);
  const current = await env.DB.prepare(`SELECT u.plan,a.subscription_ends_at FROM users u LEFT JOIN user_accounts a ON a.user_id=u.id WHERE u.id=?`).bind(user.id).first();
  return json(request, { ok: true, status: updated.status, plan: current?.plan || user.plan, subscription_ends_at: current?.subscription_ends_at || null, payment: sanitizePayment(updated) });
}
function webhookSignatureText(body) {
  const invoice = body?.Data?.Invoice || {}, txn = body?.Data?.Transaction || {};
  return `Invoice.Id=${invoice.Id ?? ""},Invoice.Status=${invoice.Status ?? ""},Transaction.Status=${txn.Status ?? ""},Transaction.PaymentId=${txn.PaymentId ?? ""},Invoice.ExternalIdentifier=${invoice.ExternalIdentifier ?? ""}`;
}
async function handleWebhook(request, env) {
  if (!env.MYFATOORAH_WEBHOOK_SECRET) return new Response("Webhook secret not configured", { status: 503 });
  const raw = await request.text(); let body; try { body = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const provided = request.headers.get("myfatoorah-signature") || request.headers.get("MyFatoorah-Signature") || "";
  const expected = await hmacBase64(env.MYFATOORAH_WEBHOOK_SECRET, webhookSignatureText(body));
  if (!provided || !constantTimeEqual(provided, expected)) return new Response("Invalid signature", { status: 401 });
  if (Number(body?.Event?.Code) !== 1 && String(body?.Event?.Name || "") !== "PAYMENT_STATUS_CHANGED") return new Response("OK", { status: 200 });
  const invoiceId = String(body?.Data?.Invoice?.Id || ""), txnStatus = String(body?.Data?.Transaction?.Status || "").toUpperCase();
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE provider_invoice_id=?").bind(invoiceId).first();
  if (!payment) return new Response("OK", { status: 200 });
  const fakeProvider = { Data: body.Data };
  if (String(body?.Data?.Invoice?.Status || "").toUpperCase() === "PAID" && txnStatus === "SUCCESS") await activatePaidPayment(env, payment, fakeProvider);
  else await updatePaymentFromProvider(env, payment, fakeProvider);
  return new Response("OK", { status: 200 });
}
function sanitizePayment(p) {
  if (!p) return null;
  return { id: p.id, plan: p.plan, amount: Number(p.amount), currency: p.currency, provider: p.provider, invoice_id: p.provider_invoice_id, payment_id: p.provider_payment_id, status: p.status, created_at: p.created_at, updated_at: p.updated_at, paid_at: p.paid_at, subscription_ends_at: p.subscription_ends_at, provider_status: p.provider_status };
}

async function emergencyAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json(request, { ok: false, error: "Invalid admin key." }, 403);
  const b = await request.json(), email = normalizeEmail(b.email), plan = b.plan ? String(b.plan) : null, addCredits = Number(b.addVideoCredits || 0);
  if (plan && !PLAN_LIMITS[plan]) return json(request, { ok: false, error: "Invalid plan." }, 400);
  const u = await env.DB.prepare("SELECT id,email,plan,video_credits FROM users WHERE email=?").bind(email).first();
  if (!u) return json(request, { ok: false, error: "User not found." }, 404);
  await ensureAccount(env, u.id, "email");
  if (plan) {
    const end = plan === "free" ? null : now() + THIRTY_DAYS;
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET plan=? WHERE id=?").bind(plan, u.id),
      env.DB.prepare("UPDATE user_accounts SET subscription_started_at=?,subscription_ends_at=?,updated_at=? WHERE user_id=?").bind(plan === "free" ? null : now(), end, now(), u.id),
    ]);
  }
  if (addCredits) await env.DB.prepare("UPDATE users SET video_credits=MAX(0,video_credits+?) WHERE id=?").bind(addCredits, u.id).run();
  const updated = await env.DB.prepare(`SELECT u.email,u.plan,u.video_credits,a.status,a.subscription_ends_at FROM users u LEFT JOIN user_accounts a ON a.user_id=u.id WHERE u.id=?`).bind(u.id).first();
  await audit(env, null, "admin.emergency_update", u.id, { plan, addCredits });
  return json(request, { ok: true, user: updated });
}
async function adminDashboard(request, env) {
  const a = await requireAdmin(request, env); if (a.error) return a.error;
  const url = new URL(request.url), q = String(url.searchParams.get("q") || "").trim().toLowerCase(), like = `%${q}%`;
  const users = await env.DB.prepare(`SELECT u.id,u.email,u.plan,u.video_credits,u.created_at,
      COALESCE(a.status,'active') AS status,COALESCE(a.auth_provider,'email') AS auth_provider,a.display_name,a.last_login_at,a.subscription_ends_at,a.admin_note,
      COALESCE((SELECT SUM(uc.count) FROM usage_counters uc WHERE uc.user_id=u.id AND (uc.period_key=? OR uc.period_key=?)),0) AS usage_total
    FROM users u LEFT JOIN user_accounts a ON a.user_id=u.id
    WHERE (?='' OR lower(u.email) LIKE ? OR lower(COALESCE(a.display_name,'')) LIKE ?)
    ORDER BY u.created_at DESC LIMIT 200`).bind(periodKey("month"), periodKey("day"), q, like, like).all();
  const summary = await env.DB.prepare(`SELECT COUNT(*) AS total_users,
    SUM(CASE WHEN u.plan!='free' THEN 1 ELSE 0 END) AS paid_users,
    SUM(CASE WHEN COALESCE(a.status,'active')='suspended' THEN 1 ELSE 0 END) AS suspended_users
    FROM users u LEFT JOIN user_accounts a ON a.user_id=u.id`).first();
  const paySummary = await env.DB.prepare(`SELECT COUNT(*) AS total_payments,
    SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_payments,
    COALESCE(SUM(CASE WHEN status='paid' AND currency='KWD' THEN amount ELSE 0 END),0) AS revenue_kwd FROM payments`).first();
  const payments = await env.DB.prepare(`SELECT p.*,u.email FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 100`).all();
  const audits = await env.DB.prepare(`SELECT e.id,e.action,e.details,e.created_at,au.email AS actor_email,tu.email AS target_email
    FROM audit_events e LEFT JOIN users au ON au.id=e.actor_user_id LEFT JOIN users tu ON tu.id=e.target_user_id ORDER BY e.id DESC LIMIT 50`).all();
  return json(request, { ok: true, summary: { ...summary, ...paySummary }, users: users.results || [], payments: (payments.results || []).map(p => ({ ...sanitizePayment(p), email: p.email })), audits: audits.results || [] });
}
async function adminUpdateUser(request, env) {
  const a = await requireAdmin(request, env); if (a.error) return a.error;
  const b = await request.json(); let u = null;
  if (b.userId) u = await env.DB.prepare("SELECT id,email,plan,video_credits FROM users WHERE id=?").bind(String(b.userId)).first();
  else if (b.email) u = await env.DB.prepare("SELECT id,email,plan,video_credits FROM users WHERE email=?").bind(normalizeEmail(b.email)).first();
  if (!u) return json(request, { ok: false, error: "User not found." }, 404);
  await ensureAccount(env, u.id, "email");
  const plan = b.plan !== undefined ? String(b.plan) : null, status = b.status !== undefined ? String(b.status) : null;
  if (plan && !PLAN_LIMITS[plan]) return json(request, { ok: false, error: "Invalid plan." }, 400);
  if (status && !["active","suspended"].includes(status)) return json(request, { ok: false, error: "Invalid status." }, 400);
  if (normalizeEmail(u.email) === ownerEmail(env) && status === "suspended") return json(request, { ok: false, error: "Owner account cannot be suspended." }, 400);
  const batch = [];
  if (plan) batch.push(env.DB.prepare("UPDATE users SET plan=? WHERE id=?").bind(plan, u.id));
  if (b.setVideoCredits !== undefined && b.setVideoCredits !== null && b.setVideoCredits !== "") {
    const c = Math.max(0, Math.floor(Number(b.setVideoCredits))); if (!Number.isFinite(c)) return json(request, { ok: false, error: "Invalid credit value." }, 400);
    batch.push(env.DB.prepare("UPDATE users SET video_credits=? WHERE id=?").bind(c, u.id));
  }
  if (b.addVideoCredits !== undefined && Number(b.addVideoCredits)) {
    const c = Math.floor(Number(b.addVideoCredits)); batch.push(env.DB.prepare("UPDATE users SET video_credits=MAX(0,video_credits+?) WHERE id=?").bind(c, u.id));
  }
  let subEnd = b.subscriptionEndsAt !== undefined ? (b.subscriptionEndsAt ? Number(b.subscriptionEndsAt) : null) : undefined;
  if (plan === "free") subEnd = null;
  if (plan && plan !== "free" && (subEnd === undefined || subEnd === null)) subEnd = now() + THIRTY_DAYS;
  const sets = [], vals = [];
  if (status) { sets.push("status=?"); vals.push(status); }
  if (subEnd !== undefined) { sets.push("subscription_started_at=?","subscription_ends_at=?"); vals.push(subEnd ? now() : null, subEnd); }
  if (b.adminNote !== undefined) { sets.push("admin_note=?"); vals.push(String(b.adminNote || "").slice(0, 2000)); }
  if (sets.length) { sets.push("updated_at=?"); vals.push(now(), u.id); batch.push(env.DB.prepare(`UPDATE user_accounts SET ${sets.join(",")} WHERE user_id=?`).bind(...vals)); }
  if (batch.length) await env.DB.batch(batch);
  await audit(env, a.user.id, "admin.user_update", u.id, { plan, status, setVideoCredits: b.setVideoCredits, addVideoCredits: b.addVideoCredits, subscriptionEndsAt: subEnd, adminNote: b.adminNote });
  const updated = await env.DB.prepare(`SELECT u.id,u.email,u.plan,u.video_credits,u.created_at,COALESCE(a.status,'active') AS status,a.auth_provider,a.last_login_at,a.subscription_ends_at,a.admin_note
    FROM users u LEFT JOIN user_accounts a ON a.user_id=u.id WHERE u.id=?`).bind(u.id).first();
  return json(request, { ok: true, user: updated });
}

async function useQuota(env, user, metric, operation) {
  if (isAdminUser(env, user)) return operation();
  if (metric === "video") {
    const charge = await env.DB.prepare("UPDATE users SET video_credits=video_credits-1 WHERE id=? AND video_credits>0")
      .bind(user.id).run();
    if (!charge.meta.changes) throw requestError("Video generation requires video credits.", 402, "VIDEO_CREDITS_REQUIRED");
    try {
      return await operation();
    } catch (error) {
      await env.DB.prepare("UPDATE users SET video_credits=video_credits+1 WHERE id=?").bind(user.id).run();
      throw error;
    }
  }
  const allowed = await checkLimit(env, user, metric);
  if (!allowed.ok) throw requestError(allowed.message, 402, allowed.code);
  const key = periodKey(allowed.spec.period);
  const quota = await env.DB.prepare(`INSERT INTO usage_counters(user_id,period_key,metric,count) VALUES(?,?,?,1)
    ON CONFLICT(user_id,period_key,metric) DO UPDATE SET count=count+1 WHERE count < ?`)
    .bind(user.id, key, metric, allowed.spec.limit).run();
  if (!quota.meta.changes) throw requestError("Usage limit reached for this tool.", 402, "LIMIT_REACHED");
  try {
    return await operation();
  } catch (error) {
    await env.DB.prepare("UPDATE usage_counters SET count=MAX(count-1,0) WHERE user_id=? AND period_key=? AND metric=?")
      .bind(user.id, key, metric).run();
    throw error;
  }
}

async function transcribe(request, env, user) {
  const form = await request.formData();
  const audio = form.get("audio");
  const language = form.get("language");
  if (!(audio instanceof File) || !audio.size || audio.size > 5 * 1024 * 1024 || !/^(audio|video)\//.test(audio.type)) {
    throw requestError("Record audio under 5 MB.");
  }
  const result = await useQuota(env, user, "chat", async () => {
    const data = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: bytesToBase64(await audio.arrayBuffer()),
      task: "transcribe",
      ...(language === "ar" || language === "en" ? { language } : {}),
    });
    if (!data?.text?.trim()) throw requestError("No speech was recognized. Try recording again.", 422);
    return data.text.trim();
  });
  return json(request, { ok: true, text: result });
}

async function handleAI(request, env, user) {
  const form = await request.formData();
  const prompt = String(form.get("prompt") || "").trim();
  const value = form.get("file");
  const file = value instanceof File && value.size > 0 ? value : null;
  const mode = form.get("mode") || "auto";
  const model = form.get("model") || "default";
  if (model !== "default" && model !== "nemotron") throw requestError("Choose a supported chat model.");
  const projectId = String(form.get("project") || "");
  const project = projectId ? await findProject(env.DB, user.id, projectId) : null;
  if (!prompt && !file) throw requestError("Type a message or attach a file.");
  if (prompt.length > 10000) throw requestError("Keep requests under 10,000 characters.");
  if (file && file.size > 12 * 1024 * 1024) throw requestError("File is too large. Use a file under 12 MB.", 413);
  const intent = mode === "image" ? (file ? "image_edit" : "image_generate")
    : mode === "video" ? (file ? "video_i2v" : "video_t2v")
    : detectIntent(prompt, file);
  const contextualChat = project && mode === "auto" && !file && ["chat", "office", "document_control"].includes(intent);
  if (mode === "document" || mode === "web" || contextualChat) {
    const question = prompt || "Summarize the main points in this document.";
    const isWeb = mode === "web";
    if (isWeb && file) throw requestError("Remove the attachment before searching the web.");
    const result = await useQuota(env, user, mode === "document" && file ? "file" : "chat", async () => {
      const documents = isWeb || !project ? [] : await projectDocuments(env.DB, project.id);
      if (file) documents.push({ name: file.name, id: "attachment", pages: await extractPdfPages(env.AI, file) });
      if (mode === "document" && !documents.length) throw requestError("Attach a PDF or add a PDF to this project first.");
      const sources = isWeb ? await webSources(env, question) : [];
      if (isWeb && !sources.length) throw requestError("No sources found. Try a more specific search.", 422);
      const recent = project && !isWeb ? await projectHistory(env.DB, project.id) : [];
      if (!project && !isWeb) {
        try {
          const context = JSON.parse(String(form.get("context") || "[]").slice(0, 10000));
          if (Array.isArray(context)) recent.push(...context.slice(-8).filter(message =>
            ["user", "assistant"].includes(message?.role) && typeof message.content === "string"));
        } catch {
          // An older or malformed client context can be ignored.
        }
      }
      return answerWithSources((system, text) => runText(env, system, text, model), question,
        { documents, sources, instructions: isWeb ? "" : project?.instructions, history: recent });
    });
    if (project) {
      const saved = result.citations.filter(ref => ref.documentId !== "attachment");
      await saveProjectAnswer(env.DB, project.id, question, result.reply, saved);
    } else {
      await storeMessage(env, user.id, "user", "text", question);
      const citations = result.citations.filter(ref => !!ref.url);
      const saved = JSON.stringify({ reply: result.reply, citations });
      await storeMessage(env, user.id, "assistant", citations.length && saved.length <= 24000 ? "sourced" : "text",
        citations.length && saved.length <= 24000 ? saved : result.reply);
    }
    return json(request, { ok: true, type: "text", ...result });
  }
  const metric = metricFor(intent, file);
  const userMessage = `${file ? "📎 " + file.name + "\n" : ""}${prompt || "Analyze this file"}`;
  if (["image", "image_edit", "video"].includes(metric)) {
    if (file && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw requestError("Choose a JPG, PNG or WebP reference image.");
    const options = { prompt, file, format: form.get("format"), style: form.get("style") };
    const video = metric === "video";
    const url = await useQuota(env, user, metric, () => video ? generateVideo(env, options) : generateImage(env, options));
    const reply = video ? "Your video is ready." : "Your image is ready.";
    if (project) await saveProjectAnswer(env.DB, project.id, userMessage, reply, []);
    else {
      await storeMessage(env, user.id, "user", "text", userMessage);
      await storeMessage(env, user.id, "assistant", video ? "video" : "image", reply);
    }
    return json(request, { ok: true, type: video ? "video" : "image", intent, reply, ...(video ? { videoUrl: url } : { imageDataUrl: url }) });
  }
  const answer = await useQuota(env, user, metric, async () => {
    if (!file) return runText(env, systemFor(intent), prompt, model);
    const content = await convertFile(env, file);
    return runText(env, systemFor(intent), `User request:\n${prompt || "Analyze this file and summarize the important information."}\n\nUploaded file: ${file.name}\n\nFile content:\n${content}`, model);
  });
  if (!project) await storeMessage(env, user.id, "user", "text", userMessage);
  if (project) await saveProjectAnswer(env.DB, project.id, userMessage, answer, []);
  else await storeMessage(env, user.id, "assistant", "text", answer);
  return json(request, { ok: true, type: "text", intent, reply: answer, artifact: artifactFor(intent) });
}

export default {
  async scheduled(event, env) {
    if (!env.NOTION_API_TOKEN) return;
    await ensureSchema(env);
    await notionDigest(env, event.scheduledTime);
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      await ensureSchema(env);

      if (request.method === "POST" && path === "/api/payments/webhook") return await handleWebhook(request, env);

      if (request.method === "GET" && path.startsWith("/api/public-file/")) {
        const key = decodeURIComponent(path.slice("/api/public-file/".length)); const obj = await env.FILES.get(key);
        if (!obj) return new Response("Not found", { status: 404 });
        const h = new Headers(); obj.writeHttpMetadata(h); h.set("Cache-Control", "public, max-age=60"); return new Response(obj.body, { headers: h });
      }

      if (request.method === "GET" && path === "/api/health") {
        const checks = { AI: !!env.AI, DB: !!env.DB, FILES: !!env.FILES, ADMIN_KEY: !!env.ADMIN_KEY, OWNER_EMAIL: !!env.OWNER_EMAIL, GOOGLE: !!env.GOOGLE_CLIENT_ID, PAYMENTS: !!env.MYFATOORAH_API_KEY, WEBHOOK: !!env.MYFATOORAH_WEBHOOK_SECRET };
        try { await env.DB.prepare("SELECT 1 AS ok").first(); checks.database = true; } catch (e) { checks.database = false; checks.database_error = String(e?.message || e); }
        const coreOk = checks.AI && checks.DB && checks.FILES && checks.ADMIN_KEY && checks.database === true;
        return json(request, { ok: coreOk, version: "6.0", checks, payment_mode: String(env.MYFATOORAH_MODE || "test") }, coreOk ? 200 : 500);
      }
      if (request.method === "GET" && path === "/api/config") {
        return json(request, { ok: true, version: "6.0", google_enabled: !!env.GOOGLE_CLIENT_ID, google_client_id: env.GOOGLE_CLIENT_ID || "", payments_enabled: !!env.MYFATOORAH_API_KEY, web_search_enabled: !!env.BRAVE_SEARCH_API_KEY, nemotron_enabled: !!String(env.NVIDIA_API_KEY || "").trim(), payment_provider: "MyFatoorah", payment_mode: String(env.MYFATOORAH_MODE || "test"), plans: Object.entries(PLAN_PRICES).map(([id,p]) => ({ id, label: planLabel(id), kwd: p.kwd, usd: p.usd })) });
      }
      if (request.method === "GET" && path === "/") return json(request, { ok: true, name: "NibrasGPT", version: "6.0", features: ["email-auth","google-auth","admin-dashboard","user-controls","myfatoorah-payments","auto-plan-activation","server-usage","chat","image","documents","website","app","code","cad","text-video","image-video","pwa"] });

      if (request.method === "POST" && path === "/api/signup") return await handleSignup(request, env);
      if (request.method === "POST" && path === "/api/login") return await handleLogin(request, env);
      if (request.method === "POST" && path === "/api/auth/google") return await handleGoogleAuth(request, env);
      if (request.method === "POST" && path === "/api/admin/set-user") return await emergencyAdmin(request, env);

      if (request.method === "POST" && path === "/api/logout") { await deleteSession(request, env); return json(request, { ok: true }); }

      const send = (body, status = 200) => json(request, body, status);
      if (path === "/api/projects" || path.startsWith("/api/projects/")) {
        const auth = await requireUser(request, env);
        if (auth.error) return auth.error;
        return await projectRoute(request, env, auth.user.id, path, send, operation => useQuota(env, auth.user, "file", operation));
      }
      if (request.method === "POST" && path === "/api/voice/transcribe") {
        const auth = await requireUser(request, env);
        if (auth.error) return auth.error;
        return await transcribe(request, env, auth.user);
      }
      if (path === "/api/notion/digest" && ["GET", "POST"].includes(request.method)) {
        const auth = await requireAdmin(request, env);
        if (auth.error) return auth.error;
        return send({ ok: true, configured: !!env.NOTION_API_TOKEN,
          digest: request.method === "POST" ? await notionDigest(env) : await latestDigest(env) });
      }

      if (request.method === "GET" && path === "/api/me") {
        const a = await requireUser(request, env); if (a.error) return a.error;
        return json(request, { ok: true, user: a.user, plan_label: a.user.is_admin ? "Owner Unlimited" : planLabel(a.user.plan), usage: await usageSummary(env, a.user) });
      }
      if (request.method === "GET" && path === "/api/history") {
        const a = await requireUser(request, env); if (a.error) return a.error;
        const r = await env.DB.prepare("SELECT role,kind,content,created_at FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 40").bind(a.user.id).all();
        const messages = (r.results || []).reverse().map(message => {
          if (message.kind !== "sourced") return message;
          const saved = JSON.parse(message.content);
          return { ...message, kind: "text", content: saved.reply, citations: saved.citations };
        });
        return json(request, { ok: true, messages });
      }
      if (request.method === "POST" && path === "/api/history/clear") {
        const a = await requireUser(request, env); if (a.error) return a.error;
        await env.DB.prepare("DELETE FROM chat_messages WHERE user_id=?").bind(a.user.id).run(); await audit(env, a.user.id, "history.clear", a.user.id); return json(request, { ok: true });
      }
      if (request.method === "GET" && path === "/api/billing") {
        const a = await requireUser(request, env); if (a.error) return a.error;
        const r = await env.DB.prepare("SELECT * FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT 30").bind(a.user.id).all();
        return json(request, { ok: true, plan: a.user.plan, plan_label: a.user.is_admin ? "Owner Unlimited" : planLabel(a.user.plan), subscription_started_at: a.user.subscription_started_at || null, subscription_ends_at: a.user.subscription_ends_at || null, payments: (r.results || []).map(sanitizePayment), payments_enabled: !!env.MYFATOORAH_API_KEY, provider: "MyFatoorah" });
      }
      if (request.method === "POST" && path === "/api/payments/create") {
        const a = await requireUser(request, env); if (a.error) return a.error; return await handleCreatePayment(request, env, a.user);
      }
      if (request.method === "POST" && path === "/api/payments/verify") {
        const a = await requireUser(request, env); if (a.error) return a.error; return await handleVerifyPayment(request, env, a.user);
      }
      if (request.method === "POST" && path === "/api/account/delete") {
        const a = await requireUser(request, env); if (a.error) return a.error;
        const b = await request.json(); if (String(b.confirm || "") !== "DELETE") return json(request, { ok: false, error: "Type DELETE to confirm account deletion." }, 400);
        if (a.user.is_admin) return json(request, { ok: false, error: "Owner account cannot be deleted here." }, 400);
        await audit(env, a.user.id, "account.delete", a.user.id);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM project_documents WHERE project_id IN (SELECT id FROM projects WHERE user_id=?)").bind(a.user.id),
          env.DB.prepare("DELETE FROM project_messages WHERE project_id IN (SELECT id FROM projects WHERE user_id=?)").bind(a.user.id),
          env.DB.prepare("DELETE FROM projects WHERE user_id=?").bind(a.user.id),
          env.DB.prepare("DELETE FROM chat_messages WHERE user_id=?").bind(a.user.id),
          env.DB.prepare("DELETE FROM usage_counters WHERE user_id=?").bind(a.user.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(a.user.id),
          env.DB.prepare("DELETE FROM payments WHERE user_id=?").bind(a.user.id),
          env.DB.prepare("DELETE FROM user_accounts WHERE user_id=?").bind(a.user.id),
          env.DB.prepare("DELETE FROM users WHERE id=?").bind(a.user.id),
        ]);
        return json(request, { ok: true });
      }
      if (request.method === "GET" && (path === "/api/integrations/notion/status" || path === "/api/integrations/notion/list")) {
        const admin = await requireAdmin(request, env);
        if (admin.error) return admin.error;
        const action = path.endsWith("/status") ? "status" : "list";
        if (action === "list" && !(await enforceAuthRate(request, env, "notion-read", 60))) {
          return json(request, { ok: false, error: "Too many Notion requests. Try again later.", code: "NOTION_LIMIT" }, 429);
        }
        return await notionReadOnly(request, env, action, (body, status = 200) => json(request, body, status));
      }
      if (request.method === "GET" && path === "/api/admin/dashboard") return await adminDashboard(request, env);
      if (request.method === "POST" && path === "/api/admin/user") return await adminUpdateUser(request, env);
      if (request.method === "POST" && path === "/api/ai") {
        const a = await requireUser(request, env); if (a.error) return a.error; return await handleAI(request, env, a.user);
      }
      return json(request, { ok: false, error: "Endpoint not found." }, 404);
    } catch (e) {
      if (e?.status >= 400 && e.status < 600) return json(request, { ok: false, error: e.message, code: e.code }, e.status);
      console.error("Worker request failed", e);
      return json(request, { ok: false, error: "Unexpected server error. Please try again." }, 500);
    }
  },
};
