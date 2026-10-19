/**
 * DataCore owner-only read-only Notion pilot.
 * Safe by default: no writes, no arbitrary page/database IDs from callers,
 * and no token in the GitHub Pages frontend or JSON responses.
 */
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const APPROVED_SOURCES = Object.freeze({
  roadmap: "bf446d4c-7bab-4457-9fc8-5f1eef310db2",
  knowledge: "d41628b2-7598-4fdd-a237-49f2e4fa8a27",
});
function limitedText(property) {
  const p = property || {};
  const parts = p.title || p.rich_text || [];
  return Array.isArray(parts) ? parts.map(t => t.plain_text || t.text?.content || "").join("").slice(0, 1200) : "";
}
function propertyText(properties, name) {
  const p = properties?.[name];
  if (!p) return "";
  if (p.type === "select" || p.type === "status") return String(p[p.type]?.name || "");
  if (p.type === "url") return String(p.url || "").slice(0, 500);
  return limitedText(p);
}
function cleanRow(page, source) {
  const p = page.properties || {};
  if (source === "roadmap") {
    return {
      id: page.id,
      url: page.url,
      title: propertyText(p, "Task"),
      product: propertyText(p, "Product"),
      status: propertyText(p, "Status"),
      priority: propertyText(p, "Priority"),
      category: propertyText(p, "Category"),
      notes: propertyText(p, "Notes"),
      githubUrl: propertyText(p, "GitHub Link"),
    };
  }
  return {
    id: page.id,
    url: page.url,
    title: propertyText(p, "Title"),
    product: propertyText(p, "Product"),
    category: propertyText(p, "Category"),
    visibility: propertyText(p, "Visibility"),
    summary: propertyText(p, "Summary"),
    sourceUrl: propertyText(p, "Source Link"),
  };
}
/**
 * Response envelope is deliberately small; this function is called ONLY after
 * requireAdmin() in worker.js has validated the caller's existing session.
 * Pass the existing json() wrapper from worker.js for consistent headers.
 */
export async function notionReadOnly(request, env, action, jsonResult) {
  const configured = !!String(env.NOTION_API_TOKEN || "").trim();
  if (action === "status") {
    return jsonResult({
      ok: true,
      enabled: false,
      configured,
      mode: "owner-only-read-only",
      message: configured ? "Credential is provisioned. Pilot is not deployed automatically." : "Set NOTION_API_TOKEN using Cloudflare Worker secrets to enable this pilot.",
      sources: Object.keys(APPROVED_SOURCES),
    });
  }
  if (action !== "list") return jsonResult({ ok: false, error: "Invalid Notion action." }, 404);
  const source = new URL(request.url).searchParams.get("source");
  if (!Object.prototype.hasOwnProperty.call(APPROVED_SOURCES, source || "")) {
    return jsonResult({ ok: false, error: "Unknown approved source." }, 400);
  }
  if (!configured) {
    return jsonResult({ ok: false, error: "Notion integration is not configured.", code: "NOTION_NOT_CONFIGURED" }, 503);
  }
  let response;
  try {
    // No caller-defined URL is ever accepted; avoids SSRF and cross-page reads.
    response = await fetch(NOTION_API + "/data_sources/" + APPROVED_SOURCES[source] + "/query", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.NOTION_API_TOKEN,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 25 }),
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return jsonResult({ ok: false, error: "Notion service is temporarily unreachable.", code: "NOTION_UPSTREAM_FAILED" }, 503);
  }
  if (!response.ok) {
    // Never echo upstream response body: it could contain private workspace info.
    return jsonResult({
      ok: false,
      error: response.status === 429 ? "Notion rate limit reached. Please retry later." : "Notion returned an error. Check integration permissions and token.",
      code: response.status === 429 ? "NOTION_RATE_LIMIT" : "NOTION_UPSTREAM_FAILED",
    }, 503);
  }
  try {
    const data = await response.json();
    if (!Array.isArray(data.results)) throw new Error("Malformed Notion response");
    return jsonResult({
      ok: true,
      source,
      mode: "owner-only-read-only",
      items: data.results.filter(r => r?.object === "page").slice(0, 25).map(r => cleanRow(r, source)),
      hasMore: !!data.has_more,
      // No pagination cursor is accepted from the caller during the initial pilot.
    });
  } catch {
    return jsonResult({ ok: false, error: "Notion returned an unreadable response.", code: "NOTION_FORMAT_ERROR" }, 502);
  }
}
