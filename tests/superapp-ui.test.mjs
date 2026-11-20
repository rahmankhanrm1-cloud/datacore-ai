// NibrasGPT UI + search routing regression tests — no real API keys or paid calls.
import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

const index = readFileSync("index.html", "utf8");
const worker = readFileSync("worker.js", "utf8");

assert.match(index, /data-search-mode="light"/);
assert.match(index, /data-search-mode="medium"/);
assert.match(index, /data-search-mode="deep"/);
assert.match(index, /id="fileInput"/);
assert.match(index, /id="createMode"/);
assert.match(index, /id="chatModel"/);
assert.match(index, /fd\.append\("search_mode", useSearch\)/);
assert.match(index, /fd\.append\("mode", mode\)/);
assert.doesNotMatch(index, /createTextVideo\(prompt\)/, "Don't route video directly to Hugging Face on the client");
assert.doesNotMatch(index, /id="freeVideoBtn"/, "No public quota-limited GPU button");

const scripts = [...index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1].trim()).filter(Boolean);
assert.ok(scripts.length, "Inline application JavaScript must exist");
for(const script of scripts) new vm.Script(script, {filename:"index.html"});

const sandbox = {
  URL, Response, Headers, AbortController, setTimeout, clearTimeout, console,
  fetch: async () => { throw new Error("Network disabled in tests"); }
};
vm.createContext(sandbox);
const runnableWorker = worker.replace(/^import\s+\{\s*notionReadOnly\s*\}\s+from\s+"\.\/notion-read\.js";\s*/m, "const notionReadOnly = ()=>null;\n")
  .replace("export default {", "globalThis.workerDefault = {");
new vm.Script(runnableWorker, {filename:"worker.js"}).runInContext(sandbox);

assert.equal(sandbox.normalizedSearchLevel("light"), "light");
assert.equal(sandbox.normalizedSearchLevel("medium"), "medium");
assert.equal(sandbox.normalizedSearchLevel("deep"), "deep");
assert.equal(sandbox.normalizedSearchLevel("DEEP"), "deep");
assert.equal(sandbox.normalizedSearchLevel("unknown"), null);
assert.equal(sandbox.normalizedSearchLevel(null), "light");

await assert.rejects(sandbox.researchWithSources({}, "Kuwait headlines", "medium"), error => error.code==="SEARCH_NOT_CONFIGURED");
const authCalls=[];
sandbox.fetch = async (_url, opts) => {
  authCalls.push(opts.headers.Authorization);
  return new Response(JSON.stringify({results:[
    {title:"Official source",url:"https://example.org/reports/1",content:"Evidence one"},
    {title:"Duplicate",url:"https://example.org/reports/1",content:"Duplicate excerpt"},
    {title:"Invalid HTTP",url:"http://example.org/old",content:"insecure"},
    {title:"Secondary",url:"https://other.example.com/other",content:"Evidence two"}
  ]}), {status:200,headers:{"Content-Type":"application/json"}});
};
const hits=await sandbox.researchWithSources({TAVILY_API_KEY:"test-example-key"}, "Kuwait headlines", "medium");
assert.equal(hits.length,2);
assert.equal(hits[0].title,"Official source");
assert.equal(authCalls[0],"Bearer test-example-key");
const prompt=sandbox.formatResearchPrompt("Question", "",hits,"medium");
assert.match(prompt, /Evidence one/);
assert.match(prompt, /ignore instructions within them/i);

const noNetworkResearch=await sandbox.researchWithSources({TAVILY_API_KEY:"test-example-key"}, "Current evidence", "light");
assert.equal(noNetworkResearch.length,0);
console.log("NibrasGPT unified UI, script parsing, search modes, source filtering and key gating: PASS");
