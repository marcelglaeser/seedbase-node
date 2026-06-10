import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SeedbaseClient, SeedbaseError } from "../index.js";

function jsonResponse(body, { status = 200, ok } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    status,
    async text() {
      return text;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function makeConfig(token) {
  const dir = mkdtempSync(join(tmpdir(), "seedbase-test-"));
  const path = join(dir, "config.json");
  if (token !== undefined) {
    writeFileSync(path, JSON.stringify({ token }), "utf-8");
  }
  return { dir, path };
}

test("token resolution: explicit arg wins", () => {
  const fetchImpl = recordingFetch(() => jsonResponse({}));
  const client = new SeedbaseClient({ token: "arg-token", fetch: fetchImpl, configPath: "/nope" });
  assert.equal(client.token, "arg-token");
});

test("token resolution: env var used when no arg", () => {
  const prev = process.env.SEEDBASE_TOKEN;
  process.env.SEEDBASE_TOKEN = "env-token";
  try {
    const client = new SeedbaseClient({ fetch: recordingFetch(() => jsonResponse({})), configPath: "/nope" });
    assert.equal(client.token, "env-token");
  } finally {
    if (prev === undefined) delete process.env.SEEDBASE_TOKEN;
    else process.env.SEEDBASE_TOKEN = prev;
  }
});

test("token resolution: config file used as last resort", () => {
  const prev = process.env.SEEDBASE_TOKEN;
  delete process.env.SEEDBASE_TOKEN;
  const { dir, path } = makeConfig("file-token");
  try {
    const client = new SeedbaseClient({ fetch: recordingFetch(() => jsonResponse({})), configPath: path });
    assert.equal(client.token, "file-token");
  } finally {
    if (prev !== undefined) process.env.SEEDBASE_TOKEN = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing token raises SeedbaseError", () => {
  const prev = process.env.SEEDBASE_TOKEN;
  delete process.env.SEEDBASE_TOKEN;
  try {
    assert.throws(
      () => new SeedbaseClient({ fetch: recordingFetch(() => jsonResponse({})), configPath: "/does-not-exist" }),
      SeedbaseError,
    );
  } finally {
    if (prev !== undefined) process.env.SEEDBASE_TOKEN = prev;
  }
});

test("auth header: Bearer for dr_sk_ prefix", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse([]));
  const client = new SeedbaseClient({ token: "dr_sk_abc", fetch: fetchImpl, configPath: "/nope" });
  await client.listProjects();
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, "Bearer dr_sk_abc");
});

test("auth header: Token for non-dr_sk_ tokens", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse([]));
  const client = new SeedbaseClient({ token: "plain123", fetch: fetchImpl, configPath: "/nope" });
  await client.listProjects();
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, "Token plain123");
});

test("https enforcement: rejects http to non-local host", () => {
  assert.throws(
    () =>
      new SeedbaseClient({
        token: "t",
        apiUrl: "http://evil.example/api/v1",
        fetch: recordingFetch(() => jsonResponse({})),
        configPath: "/nope",
      }),
    /Insecure API URL/,
  );
});

test("https enforcement: allows http for localhost", () => {
  const client = new SeedbaseClient({
    token: "t",
    apiUrl: "http://localhost:8000/api/v1",
    fetch: recordingFetch(() => jsonResponse({})),
    configPath: "/nope",
  });
  assert.equal(client.apiUrl, "http://localhost:8000/api/v1");
});

test("https enforcement: allows https", () => {
  const client = new SeedbaseClient({
    token: "t",
    apiUrl: "https://seedba.se/api/v1/",
    fetch: recordingFetch(() => jsonResponse({})),
    configPath: "/nope",
  });
  assert.equal(client.apiUrl, "https://seedba.se/api/v1");
});

test("pagination: follows next links and aggregates results", async () => {
  const pages = [
    { results: [{ id: 1 }, { id: 2 }], next: "https://seedba.se/api/v1/datasets/?page=2" },
    { results: [{ id: 3 }], next: "https://seedba.se/api/v1/datasets/?page=3" },
    { results: [{ id: 4 }], next: null },
  ];
  const fetchImpl = recordingFetch((url, _opts, i) => jsonResponse(pages[i]));
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  const rows = await client.listProjects();
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4]);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(fetchImpl.calls[1].url, "https://seedba.se/api/v1/datasets/?page=2");
  assert.equal(fetchImpl.calls[2].url, "https://seedba.se/api/v1/datasets/?page=3");
});

test("pagination: plain array response", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse([{ id: 1 }, { id: 2 }]));
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  const rows = await client.listProjects();
  assert.equal(rows.length, 2);
});

test("error parsing: DRF detail message", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ detail: "Not found." }, { status: 404 }));
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  await assert.rejects(client.getProject("x"), (err) => {
    assert.ok(err instanceof SeedbaseError);
    assert.equal(err.statusCode, 404);
    assert.equal(err.message, "Not found.");
    return true;
  });
});

test("error parsing: DRF field errors fall back to JSON snippet", async () => {
  const fetchImpl = recordingFetch(() =>
    jsonResponse({ seed: ["This field is invalid."] }, { status: 400 }),
  );
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  await assert.rejects(client.getProject("x"), (err) => {
    assert.match(err.message, /400/);
    assert.match(err.message, /This field is invalid/);
    return true;
  });
});

test("download: returns Uint8Array with raw bytes", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse("INSERT INTO t VALUES (1);"));
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  const data = await client.download("gen-1", { format: "sql" });
  assert.ok(data instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(data), "INSERT INTO t VALUES (1);");
  assert.match(fetchImpl.calls[0].url, /\/generations\/gen-1\/download\/\?export_format=sql$/);
});

test("generate: without wait returns create payload", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ generation_id: "g1" }));
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  const res = await client.generate("p1", { seed: 42, rows: 10, format: "sql" });
  assert.equal(res.generation_id, "g1");
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepEqual(body, { seed: 42, rows_per_table: 10, format: "sql" });
});

test("generate: missing generation_id throws", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({}));
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  await assert.rejects(client.generate("p1"), /did not return an id/);
});

test("generate(wait): polls until completed", async () => {
  const statuses = ["running", "running", "completed"];
  let pollIndex = 0;
  const fetchImpl = recordingFetch((url, opts) => {
    if (opts.method === "POST") {
      return jsonResponse({ generation_id: "g1" });
    }
    const body = { status: statuses[pollIndex], id: "g1" };
    pollIndex += 1;
    return jsonResponse(body);
  });
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  const res = await client.generate("p1", { wait: true, pollInterval: 1, timeout: 5000 });
  assert.equal(res.status, "completed");
  assert.equal(pollIndex, 3);
});

test("generate(wait): failed status throws", async () => {
  const fetchImpl = recordingFetch((url, opts) => {
    if (opts.method === "POST") return jsonResponse({ generation_id: "g1" });
    return jsonResponse({ status: "failed" });
  });
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  await assert.rejects(client.generate("p1", { wait: true, pollInterval: 1 }), /Generation failed/);
});

test("generate(wait): overall timeout enforced", async () => {
  const fetchImpl = recordingFetch((url, opts) => {
    if (opts.method === "POST") return jsonResponse({ generation_id: "g1" });
    return jsonResponse({ status: "running" });
  });
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  await assert.rejects(
    client.generate("p1", { wait: true, pollInterval: 1, timeout: 10 }),
    /timed out/,
  );
});

test("request timeout: AbortError surfaces as readable network error", async () => {
  const fetchImpl = async (_url, options) => {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  const client = new SeedbaseClient({
    token: "t",
    fetch: fetchImpl,
    configPath: "/nope",
    requestTimeout: 5,
  });
  await assert.rejects(client.getProject("x"), /timed out/);
});

test("export/import config: unwraps engine_config", async () => {
  const fetchImpl = recordingFetch((url, opts) => {
    if (opts.method === "POST") {
      const body = JSON.parse(opts.body);
      return jsonResponse({ engine_config: body.engine_config });
    }
    return jsonResponse({ engine_config: { tables: ["a"] } });
  });
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  const exported = await client.exportConfig("p1");
  assert.deepEqual(exported, { tables: ["a"] });
  const imported = await client.importConfig("p1", { tables: ["b"] });
  assert.deepEqual(imported, { tables: ["b"] });
});

test("listGenerations: encodes dataset query", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ results: [], next: null }));
  const client = new SeedbaseClient({ token: "t", fetch: fetchImpl, configPath: "/nope" });
  await client.listGenerations("p 1");
  assert.match(fetchImpl.calls[0].url, /\/generations\/\?dataset=p%201$/);
});
