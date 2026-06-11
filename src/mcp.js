// MCP-Server (Model Context Protocol) für SeedBase — tools-only, ohne
// Abhängigkeiten: JSON-RPC 2.0 über stdio, newline-delimitiert. Wird als
// `seedbase-mcp`-Binary ausgeliefert und z. B. von Claude Code gestartet.
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
      "Generate a fresh synthetic dataset for a project and return it as SQL INSERT statements. Optionally set rows per table. The data is foreign-key consistent.",
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
      return textResult("No projects yet. Create one at https://seedba.se first.");
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
    let sql = new TextDecoder().decode(data);
    if (sql.length > MAX_SQL_CHARS) {
      sql =
        sql.slice(0, MAX_SQL_CHARS) +
        `\n-- [truncated: full SQL is ${sql.length} chars; download generation ${generationId} via CLI or web UI]`;
    }
    return textResult(sql);
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
        serverInfo: { name: "seedbase", version: "0.2.0" },
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
      "seedbase-mcp: set SEEDBASE_API_KEY (create one at https://seedba.se -> Settings -> API keys)\n",
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
