// Prisma integration for SeedBase: fill a Prisma-managed database with realistic,
// foreign-key-consistent test data. Your schema must already exist (your
// `prisma migrate` owns it); SeedBase only fills it.
//
//   import { PrismaClient } from "@prisma/client";
//   import { seedPrisma } from "@seedbase/client/prisma";
//   import { SeedbaseClient } from "@seedbase/client";
//
//   const prisma = new PrismaClient();
//   const client = new SeedbaseClient({ token: process.env.SEEDBASE_TOKEN });
//   await seedPrisma(prisma, client, { project: process.env.SEEDBASE_PROJECT, seed: 42 });

function providerFromUrl(databaseUrl) {
  const url = String(databaseUrl || "");
  if (/^postgres(ql)?:/i.test(url)) return "postgresql";
  if (/^mysql:/i.test(url)) return "mysql";
  if (/^sqlserver:/i.test(url)) return "sqlserver";
  return "sqlite";
}

/**
 * Insert SeedBase rows into a Prisma-managed database via raw SQL, table by
 * table, in the foreign-key-safe order SeedBase emits. Returns rows inserted
 * per table.
 *
 * @param {{ $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown> }} prisma
 * @param {{ seededRows: (project: string, opts?: object) => Promise<Record<string, object[]>> }} client
 * @param {{ project: string, seed?: number, rows?: number, databaseUrl?: string }} options
 */
export async function seedPrisma(prisma, client, options = {}) {
  const { project, seed, rows, databaseUrl } = options;
  if (!project) {
    throw new Error("seedPrisma needs a project: pass { project } or SEEDBASE_PROJECT.");
  }

  const tables = await client.seededRows(project, { seed, rows });
  const provider = providerFromUrl(databaseUrl ?? process.env.DATABASE_URL);
  const placeholder = provider === "postgresql" ? (i) => `$${i + 1}` : () => "?";
  const quote = provider === "mysql" ? (name) => `\`${name}\`` : (name) => `"${name}"`;

  const counts = {};
  for (const [table, list] of Object.entries(tables)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    try {
      for (const row of list) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const sql =
          `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) ` +
          `VALUES (${columns.map((_, i) => placeholder(i)).join(", ")})`;
        await prisma.$executeRawUnsafe(sql, ...columns.map((c) => row[c]));
      }
      counts[table] = list.length;
    } catch (err) {
      // A table SeedBase emitted that this database does not have: skip it
      // (your schema owns the tables). Any other error is a real problem.
      if (/no such table|doesn't exist|does not exist|unknown table|invalid object name/i.test(String(err && err.message))) {
        continue;
      }
      throw err;
    }
  }
  return counts;
}

export { providerFromUrl };
