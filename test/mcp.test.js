import assert from "node:assert/strict";
import { test } from "node:test";

import { SeedbaseClient } from "../index.js";
import { createMcpHandler, TOOLS } from "../src/mcp.js";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";

function jsonResponse(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    },
  };
}

function makeHandler(routes) {
  const client = new SeedbaseClient({
    token: "dr_sk_test",
    apiUrl: "https://seedba.se/api/v1",
    fetch: async (url) => {
      for (const [fragment, body] of routes) {
        if (String(url).includes(fragment)) return jsonResponse(body);
      }
      return jsonResponse({ detail: `no route for ${url}` }, 404);
    },
  });
  return createMcpHandler({ client });
}

test("initialize echoes protocol version and announces tools", async () => {
  const handle = makeHandler([]);
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.equal(res.result.serverInfo.name, "seedbase");
});

test("tools/list returns the three documented tools", async () => {
  const handle = makeHandler([]);
  const res = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    res.result.tools.map((t) => t.name),
    ["list_projects", "get_ddl", "generate_test_data"],
  );
  assert.equal(res.result.tools, TOOLS);
});

test("list_projects renders projects as text", async () => {
  const handle = makeHandler([
    ["/datasets/", { results: [{ id: PROJECT_ID, name: "Shop", db_type: "mysql" }] }],
  ]);
  const res = await handle({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "list_projects", arguments: {} },
  });
  assert.match(res.result.content[0].text, /Shop \| id: 1111/);
});

test("get_ddl resolves project by name", async () => {
  const handle = makeHandler([
    [`/datasets/${PROJECT_ID}/ddl/`, { ddl: "CREATE TABLE users (id integer);", dialect: "postgresql" }],
    ["/datasets/", { results: [{ id: PROJECT_ID, name: "Shop", db_type: "postgresql" }] }],
  ]);
  const res = await handle({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "get_ddl", arguments: { project: "shop" } },
  });
  assert.match(res.result.content[0].text, /CREATE TABLE users/);
});

test("generate_test_data generates, waits and returns SQL", async () => {
  const genId = "99999999-8888-7777-6666-555555555555";
  const handle = makeHandler([
    [`/generations/${genId}/download/`, 'INSERT INTO "users" VALUES (1);'],
    [`/generations/${genId}/`, { id: genId, status: "completed" }],
    [`/datasets/${PROJECT_ID}/generate/`, { generation_id: genId, status: "queued" }],
  ]);
  const res = await handle({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "generate_test_data", arguments: { project: PROJECT_ID, rows: 5 } },
  });
  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /INSERT INTO "users"/);
});

test("tool errors come back as isError result, not protocol error", async () => {
  const handle = makeHandler([["/datasets/", { results: [] }]]);
  const res = await handle({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "get_ddl", arguments: { project: "missing" } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /No project named 'missing'/);
});

test("unknown method returns -32601, notifications return null", async () => {
  const handle = makeHandler([]);
  const err = await handle({ jsonrpc: "2.0", id: 7, method: "resources/list" });
  assert.equal(err.error.code, -32601);
  const none = await handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(none, null);
});
