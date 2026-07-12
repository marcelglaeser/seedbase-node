// MCP-Server (Model Context Protocol) für SeedBase — tools-only, ohne
// Abhängigkeiten: JSON-RPC 2.0 über stdio, newline-delimitiert. Wird als
// `seedbase-mcp`-Binary ausgeliefert und z. B. von Claude Code gestartet.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeedbaseClient } from "./client.js";

const PROTOCOL_FALLBACK = "2025-03-26";
const MAX_SQL_CHARS = 80_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TOOLS = [
  {
    name: "list_projects",
    description:
      "List your SeedBase projects (id, name, database type). Use this first to find the project to work with.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_ddl",
    description:
      "Get a project's schema as CREATE TABLE statements. Accepts a project id or name and an optional SQL dialect (postgresql, mysql, sqlite, mssql).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id (UUID) or project name" },
        dialect: {
          type: "string",
          enum: ["postgresql", "mysql", "sqlite", "mssql"],
          description: "SQL dialect for the DDL (default: the project's database type)",
        },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_test_data",
    description:
      "Generate a fresh synthetic dataset for a project and return it as SQL INSERT statements. Optionally set rows per table. The data is foreign-key consistent. Large results are written to a local .sql file instead of being returned inline (never truncated).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id (UUID) or project name" },
        rows: { type: "integer", minimum: 1, description: "Rows per table (optional; plan limits apply)" },
        seed: { type: "integer", description: "Seed for deterministic output (optional)" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "create_project",
    description: "Create a new, empty SeedBase project. Use import_schema afterwards to add the schema.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        db_type: {
          type: "string",
          enum: ["postgresql", "mysql", "sqlite", "mssql"],
          description: "Target database type (default: postgresql)",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "import_schema",
    description:
      "Import a database schema into a project from pasted content: SQL DDL (CREATE TABLE …, raw pg_dump/mysqldump schema output works), SQL INSERT dumps, CSV/TSV, JSON, or ORM model code (Django, Prisma, SQLAlchemy, …). Replaces the project's current schema.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id (UUID) or project name" },
        content: { type: "string", description: "The schema source text (e.g. the DDL)" },
        format: {
          type: "string",
          description:
            "Optional hint: sql, csv, tsv, json, or an ORM name (django, prisma, sqlalchemy, …). Auto-detected when omitted.",
        },
      },
      required: ["project", "content"],
      additionalProperties: false,
    },
  },
];

async function resolveProjectId(client, ref) {
  const wanted = String(ref || "").trim();
  if (!wanted) {
    throw new Error("project is required (id or name)");
  }
  if (UUID_RE.test(wanted)) {
    return wanted;
  }
  const projects = await client.listProjects();
  const match = projects.find(
    (p) => String(p.name || "").toLowerCase() === wanted.toLowerCase(),
  );
  if (!match) {
    const names = projects.map((p) => p.name).filter(Boolean).slice(0, 20);
    throw new Error(`No project named '${wanted}'. Available: ${names.join(", ") || "(none)"}`);
  }
  return String(match.id);
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

async function callTool(client, name, args) {
  if (name === "list_projects") {
    const projects = await client.listProjects();
    if (!projects.length) {
      return textResult("No projects yet. Create one at https://seedbase.dev first.");
    }
    const lines = projects.map(
      (p) => `- ${p.name || "(unnamed)"} | id: ${p.id} | db: ${p.db_type || "postgresql"}`,
    );
    return textResult(lines.join("\n"));
  }

  if (name === "get_ddl") {
    const projectId = await resolveProjectId(client, args.project);
    const ddl = await client.getDdl(projectId, { dialect: args.dialect || null });
    return textResult(ddl || "(empty schema)");
  }

  if (name === "generate_test_data") {
    const projectId = await resolveProjectId(client, args.project);
    const generation = await client.generate(projectId, {
      wait: true,
      rows: args.rows ?? null,
      seed: args.seed ?? null,
    });
    const generationId = String(generation.id || generation.generation_id);
    const data = await client.download(generationId, { format: "sql" });
    const sql = new TextDecoder().decode(data);
    if (sql.length > MAX_SQL_CHARS) {
      // Nie gekürzte SQL liefern — ein Agent würde den Teildatensatz
      // kommentarlos einspielen. Stattdessen komplette Datei lokal ablegen.
      const dir = mkdtempSync(join(tmpdir(), "seedbase-"));
      const filePath = join(dir, `seed-${generationId}.sql`);
      writeFileSync(filePath, sql, "utf-8");
      return textResult(
        `Generation ${generationId} completed. The SQL is ${sql.length.toLocaleString("en-US")} characters — ` +
          `too large to return inline, so the COMPLETE file was written to:\n${filePath}\n` +
          `Apply that file to your database (e.g. psql -f '${filePath}'). Do not expect inline SQL for large datasets.`,
      );
    }
    return textResult(sql);
  }

  if (name === "create_project") {
    const projectName = String(args.name || "").trim();
    if (!projectName) {
      throw new Error("name is required");
    }
    const project = await client.createProject(projectName, { dbType: args.db_type || null });
    return textResult(
      `Created project '${project.name}' (id: ${project.id}, db: ${project.db_type || "postgresql"}). ` +
        "Next: call import_schema with your DDL.",
    );
  }

  if (name === "import_schema") {
    const projectId = await resolveProjectId(client, args.project);
    const content = String(args.content || "").trim();
    if (!content) {
      throw new Error("content is required (e.g. CREATE TABLE statements)");
    }
    const result = await client.importSchema(projectId, content, { format: args.format || null });
    const summary = result?.summary || {};
    const tableCount = summary.table_count ?? Object.keys(result?.schema?.tables || {}).length;
    const fkCount = summary.fk_count ?? (result?.schema?.foreign_keys || []).length;
    const warnings = (result?.warnings || [])
      .map((w) => (typeof w === "string" ? w : w?.message))
      .filter(Boolean);
    const lines = [`Imported schema: ${tableCount} tables, ${fkCount} foreign keys.`];
    for (const w of warnings) lines.push(`Warning: ${w}`);
    lines.push("Next: call generate_test_data to produce SQL INSERTs.");
    return textResult(lines.join("\n"));
  }

  throw new Error(`Unknown tool '${name}'`);
}

export function createMcpHandler({ client }) {
  return async function handle(message) {
    const { id, method, params } = message || {};
    const respond = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, msg) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });

    if (method === "initialize") {
      return respond({
        protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "seedbase", version: "0.4.0" },
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return null;
    }
    if (method === "ping") {
      return respond({});
    }
    if (method === "tools/list") {
      return respond({ tools: TOOLS });
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        return respond(await callTool(client, name, args));
      } catch (exc) {
        return respond({
          content: [{ type: "text", text: `Error: ${exc?.message || exc}` }],
          isError: true,
        });
      }
    }
    if (id === undefined || id === null) {
      return null;
    }
    return fail(-32601, `Method not found: ${method}`);
  };
}

export function runStdioServer({ env = process.env } = {}) {
  const token = env.SEEDBASE_API_KEY || env.SEEDBASE_TOKEN;
  if (!token) {
    process.stderr.write(
      "seedbase-mcp: set SEEDBASE_API_KEY (create one at https://seedbase.dev -> Settings -> API keys)\n",
    );
    process.exit(1);
  }
  const client = new SeedbaseClient({
    token,
    apiUrl: env.SEEDBASE_API_URL || undefined,
  });
  const handle = createMcpHandler({ client });

  let buffer = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      queue = queue.then(async () => {
        const response = await handle(message);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      });
    }
  });
  // Kein process.exit(): große Antworten liegen noch im stdout-Puffer und
  // würden abgeschnitten. Nach stdin-Ende + abgearbeiteter Queue läuft der
  // Event-Loop von selbst aus, sobald stdout gespült ist.
  process.stdin.on("end", () => {
    queue.then(() => {
      process.exitCode = 0;
    });
  });
}
