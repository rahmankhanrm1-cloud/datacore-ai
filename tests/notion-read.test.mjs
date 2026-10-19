import test from "node:test";
import assert from "node:assert/strict";
import { notionReadOnly } from "../notion-read.js";

const request = (source = "roadmap") => new Request(
  "https://example.invalid/api/integrations/notion/list?source=" + encodeURIComponent(source)
);
const send = (body, status = 200) => ({ status, body });

test("status requires no token and leaks no secret", async () => {
  const result = await notionReadOnly(request(), {}, "status", send);
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, false);
  assert.equal(result.body.enabled, false);
  assert.ok(!JSON.stringify(result).includes("Bearer"));
});

test("rejects any unknown source before making a network call", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Should not fetch"); };
  try {
    const result = await notionReadOnly(request("../secrets"), { NOTION_API_TOKEN: "very-secret-token" }, "list", send);
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
  } finally { globalThis.fetch = original; }
});

test("missing server secret fails without exposing data", async () => {
  const result = await notionReadOnly(request(), {}, "list", send);
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "NOTION_NOT_CONFIGURED");
});

test("read-only query uses only allowlisted Notion URL and returns limited fields", async () => {
  const original = globalThis.fetch;
  let endpoint, init;
  globalThis.fetch = async (url, options) => {
    endpoint = url; init = options;
    return new Response(JSON.stringify({
      results: [
        { object: "page", id: "record-id", url: "https://notion.so/record-id",
          properties: {
            Task: { title: [{ plain_text: "Read-only pilot" }] },
            Product: { type: "select", select: { name: "NibrasGPT" } },
            Status: { type: "status", status: { name: "In Progress" } },
            Notes: { rich_text: [{ plain_text: "Documented" }] },
          }
        }
      ],
      has_more: false
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await notionReadOnly(request(), { NOTION_API_TOKEN: "server-token" }, "list", send);
    assert.equal(result.status, 200);
    assert.equal(result.body.items.length, 1);
    assert.equal(result.body.items[0].title, "Read-only pilot");
    assert.equal(result.body.items[0].status, "In Progress");
    assert.ok(endpoint.endsWith("/data_sources/bf446d4c-7bab-4457-9fc8-5f1eef310db2/query"));
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Notion-Version"], "2026-03-11");
    assert.equal(init.headers.Authorization, "Bearer server-token");
    assert.ok(!JSON.stringify(result).includes("server-token"));
  } finally { globalThis.fetch = original; }
});

test("upstream errors are sanitized", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("a private message from Notion", { status: 403 });
  try {
    const result = await notionReadOnly(request("knowledge"), { NOTION_API_TOKEN: "secret" }, "list", send);
    assert.equal(result.status, 503);
    assert.ok(!JSON.stringify(result).includes("private message"));
  } finally { globalThis.fetch = original; }
});

test("upstream 429 is reported as safe retriable error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("Too many requests", { status: 429 });
  try {
    const result = await notionReadOnly(request(), { NOTION_API_TOKEN: "secret" }, "list", send);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "NOTION_RATE_LIMIT");
  } finally { globalThis.fetch = original; }
});
