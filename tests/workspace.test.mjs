import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument } from "pdf-lib";
import worker from "../worker.js";

const database = new DatabaseSync(":memory:");

function prepare(sql, params = []) {
  return {
    bind: (...args) => prepare(sql, args),
    first: async () => database.prepare(sql).get(...params),
    all: async () => ({ results: database.prepare(sql).all(...params) }),
    run: async () => ({ meta: database.prepare(sql).run(...params) }),
  };
}

const env = {
  OWNER_EMAIL: "owner@example.test",
  DB: {
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  },
  AI: {
    async toMarkdown(files) {
      const results = [];
      for (const file of files) {
        assert.equal((await PDFDocument.load(await file.blob.arrayBuffer())).getPageCount(), 1);
        results.push({ name: file.name, data: file.name === "page-2.pdf" ? "Torque shall be 90 Nm." : "Document cover." });
      }
      return results.reverse();
    },
    async run(model, input) {
      if (model.includes("flux-2-dev")) {
        const request = new Response(input.multipart.body, { headers: { "content-type": input.multipart.contentType } });
        const form = await request.formData();
        assert.equal(form.get("width"), "720");
        assert.equal(form.get("height"), "1280");
        assert.match(form.get("prompt"), /Photographic realism/);
        return { image: "iVBORw0KGgo=" };
      }
      if (model.includes("seedance")) {
        if (input.prompt.startsWith("fail")) throw new Error("No credits on AI Gateway");
        assert.equal(input.resolution, "1080p");
        assert.match(input.image, /^data:image\/png;base64,/);
        return { result: { video: "https://media.example.test/result.mp4" }, state: "Completed" };
      }
      if (model.includes("whisper")) {
        assert.equal(input.language, "ar");
        assert.equal(input.audio, "bG9jYWw=");
        return { text: "ملاحظة" };
      }
      const context = JSON.parse(input.messages[1].content);
      const source = context.sources.find(source => source.text.includes("90 Nm") || source.title === "Manufacturer");
      return { response: source ? `See [${source.id}].` : "No evidence." };
    },
  },
};

function call(path, { account, method = "GET", payload } = {}) {
  const headers = { ...(account ? { Authorization: "Bearer " + account } : {}) };
  if (payload && !(payload instanceof FormData)) headers["Content-Type"] = "application/json";
  const body = payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined;
  return worker.fetch(new Request("https://local.example" + path, { method, body, headers }), env);
}

function form(values) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

test("project PDFs retain page numbers and stay private across accounts", async () => {
  await call("/api/config");
  for (const account of ["owner", "member"]) {
    database.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at,video_credits) VALUES (?,?,?,?,0,1)")
      .run(account, account + "@example.test", "", "");
    database.prepare("INSERT INTO user_accounts(user_id,updated_at) VALUES (?,0)").run(account);
    database.prepare("INSERT INTO sessions VALUES (?,?,?,0)").run(createHash("sha256").update(account).digest("hex"), account, Date.now() + 60000);
  }
  const response = await call("/api/projects", { account: "owner", method: "POST", payload: { name: "Project A" } });
  assert.equal(response.status, 201);
  const { project } = await response.json();
  const path = "/api/projects/" + project.id;
  assert.equal((await call(path, { account: "member" })).status, 404);
  assert.equal((await call(path)).status, 401);

  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const file = new File([await pdf.save()], "specification.pdf", { type: "application/pdf" });
  const upload = await call(path + "/documents", { account: "owner", method: "POST", payload: form({ file }) });
  assert.equal(upload.status, 201);
  const { document } = await upload.json();
  const pagePath = path + "/documents/" + document.id + "/pages/2";
  assert.equal((await call(pagePath, { account: "member" })).status, 404);
  const page = await (await call(pagePath, { account: "owner" })).json();
  assert.equal(page.text, "Torque shall be 90 Nm.");
  const answer = await call("/api/ai", {
    account: "owner", method: "POST", payload: form({ project: project.id, mode: "document", prompt: "Torque?" }),
  });
  assert.equal(answer.status, 200);
  const data = await answer.json();
  assert.deepEqual(data.citations, [{ title: "specification.pdf", documentId: document.id, page: 2, id: 1 }]);
  const opened = await (await call(path, { account: "owner" })).json();
  assert.deepEqual(opened.messages[1].citations, data.citations);
  assert.equal((await call(path, { account: "owner", method: "DELETE" })).status, 200);
  assert.equal((await call(pagePath, { account: "owner" })).status, 404);
});

test("media modes send valid provider payloads and refund unsuccessful video requests", async () => {
  const request = values => call("/api/ai", { account: "member", method: "POST", payload: form(values) });
  const image = await request({ mode: "image", prompt: "Industrial pipeline", format: "portrait" });
  assert.equal(image.status, 200);
  assert.match((await image.json()).imageDataUrl, /^data:image\/png;base64,/);
  const file = new File(["image"], "ref.png", { type: "image/png" });
  const failure = await request({ mode: "video", prompt: "fail", file });
  assert.equal(failure.status, 503);
  assert.equal(database.prepare("SELECT video_credits FROM users WHERE id='member'").get().video_credits, 1);
  const success = await request({ mode: "video", prompt: "Animate gently", file });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).videoUrl, "https://media.example.test/result.mp4");
  assert.equal((await request({ mode: "video", prompt: "Again", file })).status, 402);
});

test("voice, cited web search and owner-only Notion digests", async () => {
  const voice = await call("/api/voice/transcribe", {
    account: "member", method: "POST", payload: form({ language: "ar", audio: new File(["local"], "a.webm", { type: "audio/webm" }) }),
  });
  assert.equal((await voice.json()).text, "ملاحظة");
  assert.equal((await call("/api/notion/digest", { account: "member" })).status, 403);
  assert.equal((await call("/api/notion/digest", { account: "owner", method: "POST" })).status, 503);

  env.BRAVE_SEARCH_API_KEY = "test";
  env.NOTION_API_TOKEN = "test";
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const destination = new URL(url);
    if (destination.hostname === "api.search.brave.com") {
      assert.equal(options.headers["X-Subscription-Token"], "test");
      return Response.json({ web: { results: [{ title: "Manufacturer", url: "https://example.test/spec", description: "Specifications." }] } });
    }
    assert.equal(destination.hostname, "api.notion.com");
    return Response.json({ results: [
      { object: "page", id: "1", properties: { Task: { title: [{ plain_text: "Verify drawing" }] }, Status: { type: "status", status: { name: "In progress" } }, Due: { date: { start: "2025-01-01" } } } },
      { object: "page", id: "2", properties: { Status: { type: "status", status: { name: "Done" } } } },
    ] });
  };
  try {
    const search = await call("/api/ai", { account: "member", method: "POST", payload: form({ mode: "web", prompt: "Find specs" }) });
    assert.equal(search.status, 200);
    assert.equal((await search.json()).citations[0].url, "https://example.test/spec");
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    const { digest } = await (await call("/api/notion/digest", { account: "owner" })).json();
    assert.equal(digest.items.length, 1);
    assert.equal(digest.items[0].overdue, true);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("Nemotron is opt-in and keeps the NVIDIA key and errors server-side", async () => {
  const ask = (model, prompt) => call("/api/ai", {
    account: "owner", method: "POST", payload: form({ model, prompt }),
  });
  assert.equal((await (await call("/api/config")).json()).nemotron_enabled, false);
  const disabled = await ask("nemotron", "வணக்கம்");
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).code, "NEMOTRON_NOT_CONFIGURED");
  assert.equal((await ask("unknown", "Hello")).status, 400);

  env.NVIDIA_API_KEY = "mock-nvidia-key";
  const originalFetch = globalThis.fetch;
  const originalRun = env.AI.run;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer mock-nvidia-key");
    const input = JSON.parse(options.body);
    assert.equal(input.model, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.equal(input.stream, false);
    if (input.messages[1].content === "retry") return new Response("upstream details", { status: 429 });
    assert.equal(input.messages[1].content, "வணக்கம்");
    return Response.json({ choices: [{ message: { content: "வணக்கம்!", reasoning_content: "internal" } }] });
  };
  env.AI.run = async model => {
    assert.match(model, /^@cf\/meta\//);
    return { response: "Default reply." };
  };
  try {
    const config = await (await call("/api/config")).json();
    assert.equal(config.nemotron_enabled, true);
    assert.ok(!JSON.stringify(config).includes(env.NVIDIA_API_KEY));
    const custom = await (await ask("nemotron", "வணக்கம்")).json();
    assert.equal(custom.reply, "வணக்கம்!");
    assert.ok(!JSON.stringify(custom).includes("internal"));
    const defaultReply = await (await ask("default", "Hello")).json();
    assert.equal(defaultReply.reply, "Default reply.");
    assert.equal(calls, 1);
    const retry = await ask("nemotron", "retry");
    assert.equal(retry.status, 429);
    assert.equal((await retry.json()).code, "NEMOTRON_RATE_LIMIT");
  } finally {
    globalThis.fetch = originalFetch;
    env.AI.run = originalRun;
    delete env.NVIDIA_API_KEY;
  }
});
