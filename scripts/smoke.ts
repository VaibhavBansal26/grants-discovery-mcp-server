import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...getDefaultEnvironment() } }));

const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(),
  ["grants_get_opportunity", "grants_list_filter_options", "grants_search_opportunities", "grants_search_past_awards"]);

const search = await client.callTool({ name: "grants_search_opportunities", arguments: { keyword: "diabetes", limit: 3, response_format: "json" } });
assert.ok(!search.isError, JSON.stringify(search.content));
const page = search.structuredContent as { total: number; opportunities: { id: string }[] };
assert.ok(page.total > 0 && page.opportunities.length > 0, "expected hits");

const detail = await client.callTool({ name: "grants_get_opportunity", arguments: { opportunity_id: Number(page.opportunities[0].id) } });
assert.ok(!detail.isError, JSON.stringify(detail.content));
console.error((detail.content as { text: string }[])[0].text.slice(0, 600));

const filters = await client.callTool({ name: "grants_list_filter_options", arguments: {} });
assert.ok(!filters.isError && (filters.content as { text: string }[])[0].text.includes("Eligibilities"));

const awards = await client.callTool({ name: "grants_search_past_awards", arguments: { keyword: "rural diabetes", limit: 2 } });
assert.ok(!awards.isError, JSON.stringify(awards.content));

const bad = await client.callTool({ name: "grants_search_opportunities", arguments: { limit: 500 } });
assert.equal(bad.isError, true, "limit 500 must be rejected");

await client.close();
console.error("Smoke test passed");
