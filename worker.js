const CORS_BASE = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const VIDEO_T2V_MODEL = "alibaba/hh1.1-t2v";
const VIDEO_I2V_MODEL = "alibaba/hh1.1-i2v";

const PLAN_LIMITS = {
  free: {
    chat: { limit: 15, period: "day" },
    cv: { limit: 3, period: "month" },
    job: { limit: 5, period: "month" },
    interview: { limit: 5, period: "month" },
    file: { limit: 3, period: "month" },
    image: { limit: 10, period: "month" },
    image_edit: { limit: 5, period: "month" },
    code: { limit: 5, period: "month" },
    website: { limit: 0, period: "month" },
    app: { limit: 0, period: "month" },
    cad: { limit: 0, period: "month" },
  },
  ai_pro: {
    chat: { limit: 300, period: "month" },
    cv: { limit: 30, period: "month" },
    job: { limit: 50, period: "month" },
    interview: { limit: 50, period: "month" },
    file: { limit: 40, period: "month" },
    image: { limit: 60, period: "month" },
    image_edit: { limit: 30, period: "month" },
    code: { limit: 30, period: "month" },
    website: { limit: 0, period: "month" },
    app: { limit: 0, period: "month" },
    cad: { limit: 0, period: "month" },
  },
  builder: {
    chat: { limit: 800, period: "month" },
    cv: { limit: 100, period: "month" },
    job: { limit: 150, period: "month" },
    interview: { limit: 150, period: "month" },
    file: { limit: 100, period: "month" },
    image: { limit: 150, period: "month" },
    image_edit: { limit: 80, period: "month" },
    code: { limit: 200, period: "month" },
    website: { limit: 30, period: "month" },
    app: { limit: 20, period: "month" },
    cad: { limit: 0, period: "month" },
  },
  engineering: {
    chat: { limit: 1200, period: "month" },
    cv: { limit: 150, period: "month" },
    job: { limit: 200, period: "month" },
    interview: { limit: 200, period: "month" },
    file: { limit: 150, period: "month" },
    image: { limit: 250, period: "month" },
    image_edit: { limit: 120, period: "month" },
    code: { limit: 300, period: "month" },
    website: { limit: 50, period: "month" },
    app: { limit: 30, period: "month" },
    cad: { limit: 60, period: "month" },
  },
};

const PLAN_LABELS = {
  free: "Free",
  ai_pro: "AI Pro",
  builder: "Builder Pro",
  engineering: "Engineering Pro",
};

function cors(request) {
  const origin = request.headers.get("Origin") || "*";
  return { ...CORS_BASE, "Access-Control-Allow-Origin": origin };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(request), "Content-Type": "application/json; charset=utf-8" },
  });
}

function now() { return Date.now(); }
function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }
function lower(v) { return String(v || "").toLowerCase(); }
function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join(""); }

function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Bytes(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function fromBase64(s) {
  const b = atob(s);
  const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}

async function sha256(s) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function derivePassword(env, password, saltB64) {
  // Free-plan friendly password hashing: HMAC-SHA256 with a per-user salt
  // and ADMIN_KEY as a server-side pepper. Keep ADMIN_KEY stable.
  if (!env.ADMIN_KEY) throw new Error("ADMIN_KEY secret is missing.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.ADMIN_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = new TextEncoder().encode(`${saltB64}\0${password}`);
  return hex(await crypto.subtle.sign("HMAC", key, data));
}

async function createPassword(env, password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltB64 = base64Bytes(salt);
  return { salt: saltB64, hash: await derivePassword(env, password, saltB64) };
}

function periodKey(period) {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return period === "day" ? `${y}-${m}-${day}` : `${y}-${m}`;
}

async function createSession(env, userId) {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const created = now();
  const expires = created + 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)"
  ).bind(tokenHash, userId, expires, created).run();
  return token;
}

async function authUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const tokenHash = await sha256(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id,u.email,u.plan,u.video_credits,u.created_at
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>?`
  ).bind(tokenHash, now()).first();
  return row || null;
}

async function deleteSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
    .bind(await sha256(m[1])).run();
}

async function usageCount(env, userId, metric, period) {
  const key = periodKey(period);
  const row = await env.DB.prepare(
    "SELECT count FROM usage_counters WHERE user_id=? AND period_key=? AND metric=?"
  ).bind(userId, key, metric).first();
  return { key, count: Number(row?.count || 0) };
}

async function incrementUsage(env, userId, metric, period) {
  const key = periodKey(period);
  await env.DB.prepare(
    `INSERT INTO usage_counters(user_id,period_key,metric,count)
     VALUES(?,?,?,1)
     ON CONFLICT(user_id,period_key,metric) DO UPDATE SET count=count+1`
  ).bind(userId, key, metric).run();
}

async function usageSummary(env, user) {
  const plan = PLAN_LIMITS[user.plan] ? user.plan : "free";
  const limits = PLAN_LIMITS[plan];
  const out = {};
  for (const [metric, spec] of Object.entries(limits)) {
    const u = await usageCount(env, user.id, metric, spec.period);
    out[metric] = { used: u.count, limit: spec.limit, period: spec.period };
  }
  return out;
}

async function checkLimit(env, user, metric) {
  if (metric === "video") {
    if (Number(user.video_credits || 0) <= 0) {
      return { ok: false, code: "VIDEO_CREDITS_REQUIRED", message: "Video generation requires video credits." };
    }
    return { ok: true, video: true };
  }

  const plan = PLAN_LIMITS[user.plan] ? user.plan : "free";
  const spec = PLAN_LIMITS[plan][metric] || PLAN_LIMITS[plan].chat;
  if (spec.limit === 0) {
    return {
      ok: false,
      code: "UPGRADE_REQUIRED",
      message: `${PLAN_LABELS[plan]} does not include this tool. Please upgrade your plan.`,
    };
  }
  const u = await usageCount(env, user.id, metric, spec.period);
  if (u.count >= spec.limit) {
    return {
      ok: false,
      code: "LIMIT_REACHED",
      message: `${metric.replace(/_/g, " ")} limit reached for this ${spec.period}.`,
    };
  }
  return { ok: true, spec };
}

async function storeMessage(env, userId, role, kind, content) {
  const safe = String(content || "").slice(0, 24000);
  if (!safe) return;
  await env.DB.prepare(
    "INSERT INTO chat_messages(user_id,role,kind,content,created_at) VALUES(?,?,?,?,?)"
  ).bind(userId, role, kind, safe, now()).run();
}

function isImage(file) {
  if (!file) return false;
  const t = lower(file.type), n = lower(file.name);
  return t.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/.test(n);
}

function isPlainText(file) {
  if (!file) return false;
  const t = lower(file.type), n = lower(file.name);
  return t.startsWith("text/") ||
    /\.(txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|scss|py|java|kt|xml|yaml|yml|toml|ini|sql|sh|ps1|c|cpp|h|hpp|go|rs|php|rb|swift|dart|scr|lsp|scad|dxf)$/.test(n);
}

function detectIntent(prompt, file) {
  const p = lower(prompt);
  const hasFile = !!file;
  const img = isImage(file);

  const videoWords = /\b(video|animate|animation|image to video|text to video|make .* move|camera orbit|orbit camera|camera move|motion|cinematic clip|short clip)\b/;
  if (hasFile && img && videoWords.test(p)) return "video_i2v";
  if (!hasFile && videoWords.test(p) && /\b(create|generate|make|text to video|video)\b/.test(p)) return "video_t2v";

  if (/\b(autocad|auto cad|cad|3d diagram|3d model|3d drawing|piping isometric|isometric drawing|pipe routing|pipeline layout|equipment layout|plant layout|oil and gas|oil & gas|p&id|pid drawing|civil drawing|structural drawing|mechanical layout)\b/.test(p)) return "cad";

  const imageEdit = /\b(edit|change|replace|remove|add|modify|transform|enhance|retouch|upscale|background|dress|shirt|hair|lighting|cinematic|make this|turn this|keep .* face|keep .* subject)\b/.test(p);
  const imageAnalyze = /\b(what is|what's|describe|analy[sz]e|explain|identify|read|tell me about|what do you see|extract text|ocr)\b/.test(p);
  const imageCreate = /\b(generate|create|make|draw|render|design)\b.*\b(image|photo|picture|poster|logo|illustration|art|wallpaper|drone view|aerial view)\b|\b(text\s*to\s*image|image generation|drone view|aerial view)\b/.test(p);

  if (hasFile && img) {
    if (imageAnalyze && !imageEdit) return "image_analysis";
    return "image_edit";
  }
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
  if (intent === "video_i2v" || intent === "video_t2v") return "video";
  if (intent === "image_generate") return "image";
  if (intent === "image_edit") return "image_edit";
  if (intent === "cv") return "cv";
  if (intent === "job") return "job";
  if (intent === "interview") return "interview";
  if (intent === "website") return "website";
  if (intent === "app") return "app";
  if (intent === "code") return "code";
  if (intent === "cad") return "cad";
  if (file) return "file";
  return "chat";
}

function systemFor(intent) {
  const base = "You are DataCore AI. Be accurate, practical and professional. Never invent user facts.";
  const map = {
    chat: `${base} Answer the user's request directly.`,
    cv: `${base} You are an ATS CV/Resume specialist for all industries. Use only supplied facts. Mark missing critical information as [Add details]. Use clear headings and strong concise bullet points.`,
    job: `${base} Help with job applications, cover letters and job-description matching. Never invent qualifications or employment history.`,
    interview: `${base} Prepare realistic interview questions, strong sample answers and job-match analysis using only the user's supplied background.`,
    excel: `${base} You are an Excel/spreadsheet specialist. Give exact formulas when possible and practical data-cleaning/analysis steps.`,
    document_control: `${base} You are a broad Document Control specialist for engineering, construction, oil & gas and general business. Help with registers, transmittals, revisions, status tracking, correspondence, WIR, ITP, MIR, NCR, method statements and project document workflows.`,
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

async function runText(env, system, prompt) {
  const r = await env.AI.run(TEXT_MODEL, {
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    max_tokens: 3000,
    temperature: 0.25,
  });
  return r?.response || "";
}

async function runFlux(env, prompt, sourceBlob = null) {
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("width", "1024");
  fd.append("height", "1024");
  if (sourceBlob) fd.append("input_image_0", sourceBlob, "reference.jpg");
  const encoded = new Response(fd);
  const r = await env.AI.run(IMAGE_MODEL, {
    multipart: { body: encoded.body, contentType: encoded.headers.get("content-type") },
  });
  if (!r?.image) throw new Error("Image generation failed.");
  return `data:image/jpeg;base64,${r.image}`;
}

async function convertFile(env, file) {
  if (isPlainText(file)) return (await file.text()).slice(0, 100000);
  const r = await env.AI.toMarkdown(
    {
      name: file.name || "upload",
      blob: new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }),
    },
    { conversionOptions: { output: { format: "markdown" }, pdf: { metadata: false }, image: { descriptionLanguage: "en" } } }
  );
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

async function generateTextVideo(env, prompt) {
  const r = await env.AI.run(VIDEO_T2V_MODEL, {
    prompt,
    duration: 5,
    ratio: "16:9",
    resolution: "720P",
    watermark: false,
  });
  const url = r?.result?.video || r?.video;
  if (!url) throw new Error("Video model did not return a video URL.");
  return url;
}

async function generateImageVideo(request, env, file, prompt) {
  const key = `temp/${crypto.randomUUID()}.jpg`;
  await env.FILES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "image/jpeg" },
  });
  const origin = new URL(request.url).origin;
  const imageUrl = `${origin}/api/public-file/${encodeURIComponent(key)}`;
  try {
    const r = await env.AI.run(VIDEO_I2V_MODEL, {
      image: imageUrl,
      prompt: prompt || "Animate this image naturally with smooth cinematic camera motion.",
      duration: 5,
      resolution: "720P",
      watermark: false,
    });
    const url = r?.result?.video || r?.video;
    if (!url) throw new Error("Video model did not return a video URL.");
    return url;
  } finally {
    await env.FILES.delete(key);
  }
}

async function decrementVideoCredit(env, userId) {
  await env.DB.prepare(
    "UPDATE users SET video_credits=CASE WHEN video_credits>0 THEN video_credits-1 ELSE 0 END WHERE id=?"
  ).bind(userId).run();
}

async function handleSignup(request, env) {
  const b = await request.json();
  const email = normalizeEmail(b.email);
  const password = String(b.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(request, { ok: false, error: "Enter a valid email." }, 400);
  if (password.length < 8) return json(request, { ok: false, error: "Password must be at least 8 characters." }, 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  if (existing) return json(request, { ok: false, error: "An account with this email already exists." }, 409);

  const id = crypto.randomUUID();
  const p = await createPassword(env, password);
  await env.DB.prepare(
    "INSERT INTO users(id,email,password_hash,password_salt,plan,video_credits,created_at) VALUES(?,?,?,?,?,?,?)"
  ).bind(id, email, p.hash, p.salt, "free", 0, now()).run();
  const token = await createSession(env, id);
  return json(request, { ok: true, token, user: { id, email, plan: "free", video_credits: 0 } });
}

async function handleLogin(request, env) {
  const b = await request.json();
  const email = normalizeEmail(b.email);
  const password = String(b.password || "");
  const u = await env.DB.prepare(
    "SELECT id,email,password_hash,password_salt,plan,video_credits,created_at FROM users WHERE email=?"
  ).bind(email).first();
  if (!u) return json(request, { ok: false, error: "Invalid email or password." }, 401);
  const h = await derivePassword(env, password, u.password_salt);
  if (h !== u.password_hash) return json(request, { ok: false, error: "Invalid email or password." }, 401);
  const token = await createSession(env, u.id);
  return json(request, { ok: true, token, user: { id: u.id, email: u.email, plan: u.plan, video_credits: u.video_credits } });
}

async function requireUser(request, env) {
  const u = await authUser(request, env);
  if (!u) return { error: json(request, { ok: false, error: "Please sign in first.", code: "AUTH_REQUIRED" }, 401) };
  return { user: u };
}

async function handleAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json(request, { ok: false, error: "Invalid admin key." }, 403);
  const b = await request.json();
  const email = normalizeEmail(b.email);
  const plan = b.plan ? String(b.plan) : null;
  const addCredits = Number(b.addVideoCredits || 0);
  if (plan && !PLAN_LIMITS[plan]) return json(request, { ok: false, error: "Invalid plan." }, 400);
  const u = await env.DB.prepare("SELECT id,email,plan,video_credits FROM users WHERE email=?").bind(email).first();
  if (!u) return json(request, { ok: false, error: "User not found." }, 404);
  if (plan) await env.DB.prepare("UPDATE users SET plan=? WHERE id=?").bind(plan, u.id).run();
  if (addCredits) await env.DB.prepare("UPDATE users SET video_credits=video_credits+? WHERE id=?").bind(addCredits, u.id).run();
  const updated = await env.DB.prepare("SELECT email,plan,video_credits FROM users WHERE id=?").bind(u.id).first();
  return json(request, { ok: true, user: updated });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path.startsWith("/api/public-file/")) {
        const key = decodeURIComponent(path.slice("/api/public-file/".length));
        const obj = await env.FILES.get(key);
        if (!obj) return new Response("Not found", { status: 404 });
        const h = new Headers();
        obj.writeHttpMetadata(h);
        h.set("Cache-Control", "public, max-age=60");
        return new Response(obj.body, { headers: h });
      }

      if (request.method === "GET" && path === "/api/health") {
        const checks = { AI: !!env.AI, DB: !!env.DB, FILES: !!env.FILES, ADMIN_KEY: !!env.ADMIN_KEY };
        try {
          await env.DB.prepare("SELECT 1 AS ok").first();
          checks.database = true;
        } catch (e) {
          checks.database = false;
          checks.database_error = String(e?.message || e);
        }
        const healthOk = checks.AI && checks.DB && checks.FILES && checks.ADMIN_KEY && checks.database === true;
        return json(request, { ok: healthOk, version: "5.1", checks }, healthOk ? 200 : 500);
      }

      if (request.method === "GET" && path === "/") {
        return json(request, {
          ok: true,
          name: "DataCore AI",
          version: "5.1",
          features: ["auth", "server-usage", "chat", "image", "documents", "website", "app", "code", "cad", "text-video", "image-video"],
        });
      }

      if (request.method === "POST" && path === "/api/signup") return await handleSignup(request, env);
      if (request.method === "POST" && path === "/api/login") return await handleLogin(request, env);
      if (request.method === "POST" && path === "/api/admin/set-user") return await handleAdmin(request, env);

      if (request.method === "POST" && path === "/api/logout") {
        await deleteSession(request, env);
        return json(request, { ok: true });
      }

      if (request.method === "GET" && path === "/api/me") {
        const a = await requireUser(request, env);
        if (a.error) return a.error;
        return json(request, {
          ok: true,
          user: a.user,
          plan_label: PLAN_LABELS[a.user.plan] || "Free",
          usage: await usageSummary(env, a.user),
        });
      }

      if (request.method === "GET" && path === "/api/history") {
        const a = await requireUser(request, env);
        if (a.error) return a.error;
        const r = await env.DB.prepare(
          "SELECT role,kind,content,created_at FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 40"
        ).bind(a.user.id).all();
        return json(request, { ok: true, messages: (r.results || []).reverse() });
      }

      if (request.method === "POST" && path === "/api/history/clear") {
        const a = await requireUser(request, env);
        if (a.error) return a.error;
        await env.DB.prepare("DELETE FROM chat_messages WHERE user_id=?").bind(a.user.id).run();
        return json(request, { ok: true });
      }

      if (request.method === "POST" && path === "/api/ai") {
        const a = await requireUser(request, env);
        if (a.error) return a.error;
        const user = a.user;

        const form = await request.formData();
        const prompt = String(form.get("prompt") || "").trim();
        const fv = form.get("file");
        const file = fv instanceof File && fv.size > 0 ? fv : null;
        if (!prompt && !file) return json(request, { ok: false, error: "Type a message or attach a file." }, 400);
        if (file && file.size > 12 * 1024 * 1024) return json(request, { ok: false, error: "File is too large. Use a file under 12 MB." }, 413);

        const intent = detectIntent(prompt, file);
        const metric = metricFor(intent, file);
        const allowed = await checkLimit(env, user, metric);
        if (!allowed.ok) return json(request, { ok: false, error: allowed.message, code: allowed.code, intent }, 402);

        await storeMessage(env, user.id, "user", "text", `${file ? `📎 ${file.name}\n` : ""}${prompt || "Analyze this file"}`);

        if (intent === "image_generate") {
          const dataUrl = await runFlux(env, prompt);
          await incrementUsage(env, user.id, "image", (PLAN_LIMITS[user.plan] || PLAN_LIMITS.free).image.period);
          await storeMessage(env, user.id, "assistant", "image", "Generated image.");
          return json(request, { ok: true, type: "image", intent, reply: "Here is your generated image.", imageDataUrl: dataUrl });
        }

        if (intent === "image_edit") {
          const blob = new Blob([await file.arrayBuffer()], { type: file.type || "image/jpeg" });
          const dataUrl = await runFlux(env, `Use input image 0 as the source image. Preserve the main subject and identity unless the user explicitly asks to change them. Apply this edit: ${prompt || "Improve this image naturally."}`, blob);
          await incrementUsage(env, user.id, "image_edit", (PLAN_LIMITS[user.plan] || PLAN_LIMITS.free).image_edit.period);
          await storeMessage(env, user.id, "assistant", "image", "Edited image.");
          return json(request, { ok: true, type: "image", intent, reply: "Here is your edited image.", imageDataUrl: dataUrl });
        }

        if (intent === "video_t2v" || intent === "video_i2v") {
          let videoUrl;
          try {
            videoUrl = intent === "video_i2v"
              ? await generateImageVideo(request, env, file, prompt)
              : await generateTextVideo(env, prompt);
          } catch (e) {
            const msg = String(e?.message || "");
            if (/billing|credit|payment|unified|permission/i.test(msg)) {
              return json(request, {
                ok: false,
                code: "VIDEO_BILLING_REQUIRED",
                error: "Video generation is connected, but your Cloudflare account needs Unified Billing/prepaid AI credits before the third-party video model can run.",
              }, 402);
            }
            throw e;
          }
          await decrementVideoCredit(env, user.id);
          await storeMessage(env, user.id, "assistant", "video", "Generated video.");
          return json(request, { ok: true, type: "video", intent, reply: "Here is your generated video.", videoUrl });
        }

        let answer;
        if (file) {
          const content = await convertFile(env, file);
          answer = await runText(
            env,
            systemFor(intent === "file_analysis" ? "file_analysis" : intent),
            `User request:\n${prompt || "Analyze this file and summarize the important information."}\n\nUploaded file: ${file.name}\n\nFile content:\n${content}`
          );
        } else {
          answer = await runText(env, systemFor(intent), prompt);
        }

        const activePlan = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
        const metricSpec = activePlan[metric] || activePlan.chat;
        await incrementUsage(env, user.id, metric, metricSpec.period);
        await storeMessage(env, user.id, "assistant", "text", answer);

        return json(request, {
          ok: true,
          type: "text",
          intent,
          reply: answer,
          artifact: artifactFor(intent),
        });
      }

      return json(request, { ok: false, error: "Endpoint not found." }, 404);
    } catch (e) {
      return json(request, { ok: false, error: e?.message || "Unexpected server error." }, 500);
    }
  },
};