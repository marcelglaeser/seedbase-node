import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const API_URL = "https://seedba.se/api/v1";
export const DEFAULT_REQUEST_TIMEOUT = 30000;
export const DEFAULT_GENERATION_TIMEOUT = 300000;
const MAX_PAGES = 50;
const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function defaultConfigPath() {
  return join(homedir(), ".seedbase", "config.json");
}

export class SeedbaseError extends Error {
  constructor(message, statusCode = null) {
    super(message);
    this.name = "SeedbaseError";
    this.statusCode = statusCode;
  }
}

function validateApiUrl(apiUrl) {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new SeedbaseError(`Invalid API URL '${apiUrl}'.`);
  }
  if (parsed.protocol === "https:") {
    return apiUrl;
  }
  const host = (parsed.hostname || "").toLowerCase();
  if (parsed.protocol === "http:" && LOCAL_API_HOSTS.has(host)) {
    return apiUrl;
  }
  throw new SeedbaseError(
    `Insecure API URL '${apiUrl}' — only https:// is allowed ` +
      "(http:// is only accepted for localhost/127.0.0.1/::1).",
  );
}

function loadTokenFromConfig(configPath) {
  let content;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload.token ? String(payload.token) : null;
}

function authHeader(token) {
  if (!token) {
    return {};
  }
  if (token.startsWith("dr_sk_")) {
    return { Authorization: `Bearer ${token}` };
  }
  return { Authorization: `Token ${token}` };
}

function extractResults(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item));
  }
  if (payload !== null && typeof payload === "object" && Array.isArray(payload.results)) {
    return payload.results.filter(
      (item) => item !== null && typeof item === "object" && !Array.isArray(item),
    );
  }
  return [];
}

function nextPagePath(nextUrl, apiUrl) {
  if (nextUrl.startsWith(apiUrl)) {
    return nextUrl.slice(apiUrl.length);
  }
  let parsed;
  try {
    parsed = new URL(nextUrl, apiUrl);
  } catch {
    return nextUrl;
  }
  let rel = parsed.pathname + (parsed.search || "");
  let basePath;
  try {
    basePath = new URL(apiUrl).pathname;
  } catch {
    basePath = "";
  }
  if (basePath && rel.startsWith(basePath)) {
    rel = rel.slice(basePath.length);
  }
  return rel;
}

function httpErrorMessage(code, text) {
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.detail) {
    return String(parsed.detail);
  }
  let snippet;
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length)
  ) {
    snippet = JSON.stringify(parsed);
  } else {
    snippet = (text || "").trim();
  }
  snippet = snippet.slice(0, 300);
  if (snippet) {
    return `API request failed (${code}): ${snippet}`;
  }
  return `API request failed (${code})`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SeedbaseClient {
  constructor({
    token = null,
    apiUrl = API_URL,
    configPath = null,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT,
    fetch: fetchImpl = null,
  } = {}) {
    const path = configPath || defaultConfigPath();
    const resolved = token || process.env.SEEDBASE_TOKEN || loadTokenFromConfig(path);
    if (!resolved) {
      throw new SeedbaseError(
        "No token provided. Pass token: ..., set SEEDBASE_TOKEN, or run 'seedbase login'.",
      );
    }
    this.token = resolved;
    this.apiUrl = validateApiUrl(String(apiUrl).replace(/\/+$/, ""));
    this.requestTimeout = Number(requestTimeout);
    this._fetch = fetchImpl || globalThis.fetch;
    if (typeof this._fetch !== "function") {
      throw new SeedbaseError(
        "No fetch implementation available. Node 18+ is required, or pass fetch: ...",
      );
    }
  }

  async _request(method, path, { payload = null, raw = false } = {}) {
    const rel = path.startsWith("/") ? path : `/${path}`;
    const url = `${this.apiUrl}${rel}`;

    const headers = { ...authHeader(this.token) };
    let body;
    if (!raw) {
      headers.Accept = "application/json";
    }
    if (payload !== null && payload !== undefined) {
      body = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeout);
    let resp;
    try {
      resp = await this._fetch(url, {
        method: method.toUpperCase(),
        headers,
        body,
        signal: controller.signal,
      });
    } catch (exc) {
      if (exc && exc.name === "AbortError") {
        throw new SeedbaseError(`Network error: request to ${url} timed out`);
      }
      throw new SeedbaseError(`Network error: ${exc && exc.message ? exc.message : exc}`);
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      let text = "";
      try {
        text = await resp.text();
      } catch {
        text = "";
      }
      throw new SeedbaseError(httpErrorMessage(resp.status, text), resp.status);
    }

    if (raw) {
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    }

    const text = await resp.text();
    if (!text.trim()) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SeedbaseError(`Server returned an unexpected non-JSON response from ${url}`);
    }
  }

  async _requestList(path) {
    const rows = [];
    let nextPath = path;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      if (!nextPath) {
        break;
      }
      const data = await this._request("GET", nextPath);
      rows.push(...extractResults(data));
      const nextUrl = data !== null && typeof data === "object" ? data.next : null;
      nextPath = nextUrl ? nextPagePath(String(nextUrl), this.apiUrl) : null;
    }
    return rows;
  }

  async listProjects() {
    return this._requestList("/datasets/");
  }

  async getProject(projectId) {
    return this._request("GET", `/datasets/${projectId}/`);
  }

  async listGenerations(projectId) {
    return this._requestList(`/generations/?dataset=${encodeURIComponent(projectId)}`);
  }

  async getGeneration(generationId) {
    return this._request("GET", `/generations/${generationId}/`);
  }

  async generate(
    projectId,
    {
      seed = null,
      rows = null,
      format = null,
      rebaseTo = null,
      wait = false,
      timeout = DEFAULT_GENERATION_TIMEOUT,
      pollInterval = 2000,
    } = {},
  ) {
    const payload = {};
    if (seed !== null && seed !== undefined) {
      payload.seed = seed;
    }
    if (rows !== null && rows !== undefined) {
      payload.rows_per_table = Math.max(1, rows);
    }
    if (format) {
      payload.format = format;
    }
    if (rebaseTo !== null && rebaseTo !== undefined) {
      payload.rebase_to = rebaseTo;
    }

    const create = await this._request("POST", `/datasets/${projectId}/generate/`, { payload });
    const generationId = create && create.generation_id;
    if (!generationId) {
      throw new SeedbaseError("Generation did not return an id");
    }

    if (!wait) {
      return create;
    }

    const deadline = Date.now() + Math.max(1000, timeout);
    let consecutiveErrors = 0;
    for (;;) {
      let statusData = null;
      try {
        statusData = await this.getGeneration(generationId);
        consecutiveErrors = 0;
      } catch (exc) {
        if (!(exc instanceof SeedbaseError)) {
          throw exc;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) {
          throw exc;
        }
      }
      if (statusData !== null) {
        const status = statusData.status;
        if (TERMINAL_STATUSES.has(status)) {
          if (status !== "completed") {
            throw new SeedbaseError(`Generation ${status}`);
          }
          return statusData;
        }
      }
      if (Date.now() >= deadline) {
        throw new SeedbaseError("Generation timed out");
      }
      await sleep(pollInterval);
    }
  }

  async exportConfig(projectId) {
    const data = await this._request("GET", `/datasets/${projectId}/export-config/`);
    const config = data !== null && typeof data === "object" ? data.engine_config : null;
    return config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
  }

  async importConfig(projectId, config) {
    const data = await this._request("POST", `/datasets/${projectId}/import-config/`, {
      payload: { engine_config: config },
    });
    const result = data !== null && typeof data === "object" ? data.engine_config : null;
    return result !== null && typeof result === "object" && !Array.isArray(result) ? result : {};
  }

  async download(generationId, { format = null } = {}) {
    const exportFormat = format || "sql";
    const path = `/generations/${generationId}/download/?export_format=${encodeURIComponent(exportFormat)}`;
    return this._request("GET", path, { raw: true });
  }
}
