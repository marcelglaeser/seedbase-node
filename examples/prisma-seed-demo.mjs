// Runnable demo for the SeedBase Prisma integration.
//
//   node packages/seedbase-node/examples/prisma-seed-demo.mjs
//
// Fills a Prisma-managed database with realistic, foreign-key-consistent data,
// then runs a join to show the foreign keys line up. It runs out of the box with
// a tiny fake Prisma client backed by in-memory SQLite (node:sqlite), so you see
// the mechanic with no setup.
//
// In a real project (prisma/seed.ts):
//
//   import { PrismaClient } from "@prisma/client";
//   import { SeedbaseClient } from "@seedbase/client";
//   import { seedPrisma } from "@seedbase/client/prisma";
//
//   const prisma = new PrismaClient();
//   const client = new SeedbaseClient({ token: process.env.SEEDBASE_TOKEN });
//   await seedPrisma(prisma, client, { project: process.env.SEEDBASE_PROJECT, seed: 42 });
//
// then run it with `prisma db seed`.

import { DatabaseSync } from "node:sqlite";
import { seedPrisma } from "../src/prisma.js";

// A stand-in SeedBase client returning canned data so the demo runs offline.
// Replace with `new SeedbaseClient({ token: process.env.SEEDBASE_TOKEN })`.
const demoClient = {
  async seededRows(projectId, options = {}) {
    return {
      users: [
        { id: 1, name: "Mia Hofer", email: "mia.hofer@gmx.de" },
        { id: 2, name: "Jonas Weber", email: "jonas.weber@web.de" },
      ],
      orders: [
        { id: 10, user_id: 1, total: "49.90" },
        { id: 11, user_id: 2, total: "12.50" },
        { id: 12, user_id: 1, total: "7.00" },
      ],
    };
  },
};

// A database with your schema already in place (your `prisma migrate` owns this).
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total TEXT)");

// A minimal Prisma-like client (your real PrismaClient already has this method).
const prisma = {
  async $executeRawUnsafe(sql, ...values) {
    db.prepare(sql).run(...values);
  },
};

// Fill it with realistic, foreign-key-consistent data. One call.
const counts = await seedPrisma(prisma, demoClient, { project: "demo-project", seed: 42, databaseUrl: "file:./demo.db" });

// Use it: the join just works.
console.log("Seeded rows per table:", JSON.stringify(counts), "\n");
const joined = db
  .prepare(
    `SELECT o.id, u.name, u.email, o.total
       FROM orders o JOIN users u ON u.id = o.user_id
   ORDER BY o.id`
  )
  .all();
for (const r of joined) {
  console.log(`order #${r.id}  ${r.name.padEnd(14)} ${r.email.padEnd(24)} EUR ${r.total}`);
}
