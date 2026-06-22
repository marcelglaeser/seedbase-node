import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SeedbaseClient } from "../index.js";
import { seedPrisma, providerFromUrl } from "../src/prisma.js";

function jsonResponse(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    async text() {
      return text;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    },
  };
}

function seedbaseFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes("/generate/")) return jsonResponse({ generation_id: "g1" });
    if (u.includes("/download/")) {
      return jsonResponse(
        JSON.stringify({
          users: [
            { id: 1, email: "a@b.co" },
            { id: 2, email: "c@d.co" },
          ],
          // a table SeedBase emitted that the test DB does not have: must be skipped
          audit_log: [{ id: 9, message: "x" }],
        })
      );
    }
    if (u.includes("/generations/")) return jsonResponse({ id: "g1", status: "completed" });
    return jsonResponse({});
  };
}

test("providerFromUrl detects the dialect", () => {
  assert.equal(providerFromUrl("postgresql://u:p@h/db"), "postgresql");
  assert.equal(providerFromUrl("mysql://u:p@h/db"), "mysql");
  assert.equal(providerFromUrl("file:./dev.db"), "sqlite");
  assert.equal(providerFromUrl(undefined), "sqlite");
});

test("seedPrisma fills an existing schema and skips missing tables", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");

  const prisma = {
    async $executeRawUnsafe(sql, ...values) {
      db.prepare(sql).run(...values);
    },
  };

  const client = new SeedbaseClient({
    token: "dr_sk_test",
    configPath: "/nope",
    fetch: seedbaseFetch(),
  });

  const counts = await seedPrisma(prisma, client, { project: "proj-1", seed: 7, databaseUrl: "file:./x.db" });

  assert.deepEqual(counts, { users: 2 });
  const emails = db.prepare("SELECT email FROM users ORDER BY id").all().map((r) => r.email);
  assert.deepEqual(emails, ["a@b.co", "c@d.co"]);
});
