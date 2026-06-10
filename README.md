<p align="center">
  <img src="https://seedba.se/seedbase-logo-256.png" alt="Seedbase" width="120" />
</p>

# @seedbase/client

Generate realistic, relationship-preserving, privacy-safe test data for your databases — and pull it straight into your local or CI database.

Seedbase lives on [seedba.se](https://seedba.se): you model (or import) a schema there, generate datasets, and use this package to pull them into Postgres, MySQL, SQLite and more. Schema-aware, foreign-key-correct, reproducible by seed.

This is the Node.js client, a counterpart to the [Python SDK](https://pypi.org/project/seedbase/).

## Install

```bash
npm install @seedbase/client
```

Zero runtime dependencies — pure ESM, built on the native `fetch` of Node 18+.

## Quickstart

```js
import { SeedbaseClient } from "@seedbase/client";

// Token from the argument, $SEEDBASE_TOKEN, or ~/.seedbase/config.json
const client = new SeedbaseClient({ token: "dr_sk_..." });

// Trigger a generation and wait for it to finish
const gen = await client.generate(projectId, { seed: 42, wait: true });

// Download the result (Uint8Array)
const bytes = await client.download(gen.id, { format: "sql" });
import { writeFile } from "node:fs/promises";
await writeFile("dump.sql", bytes);
```

## Authentication

The token is resolved in this order:

1. The `token` option passed to the constructor.
2. The `SEEDBASE_TOKEN` environment variable.
3. The `token` field in `~/.seedbase/config.json` (written by `seedbase login`).

API keys with the `dr_sk_` prefix are sent as `Authorization: Bearer ...`, other
tokens as `Authorization: Token ...`. Get a key at
[seedba.se/settings?tab=api-keys](https://seedba.se/settings?tab=api-keys).

## API

```js
new SeedbaseClient({
  token,            // optional, see resolution order above
  apiUrl,           // default "https://seedba.se/api/v1" (https enforced, http only for localhost)
  configPath,       // override ~/.seedbase/config.json
  requestTimeout,   // per-request timeout in ms, default 30000
  fetch,            // inject a custom fetch (e.g. for tests)
});
```

| Method | Description |
| --- | --- |
| `listProjects()` | All datasets/projects (paginated, followed automatically). |
| `getProject(projectId)` | A single project. |
| `listGenerations(projectId)` | Generations for a project (paginated). |
| `getGeneration(generationId)` | A single generation. |
| `generate(projectId, opts)` | Trigger a generation. `opts`: `{ seed, rows, format, rebaseTo, wait, timeout, pollInterval }`. With `wait: true` it polls until the generation reaches `completed`/`failed`/`cancelled`. |
| `download(generationId, { format })` | Download the generated artifact as a `Uint8Array`. `format` defaults to `"sql"`. |
| `exportConfig(projectId)` | The project's engine config as an object. |
| `importConfig(projectId, config)` | Replace the project's engine config. |

All methods are async and return Promises. Failures throw a `SeedbaseError`
(with `.statusCode` for HTTP errors), carrying a readable message that includes
the server's `detail` or field errors.

```js
import { SeedbaseError } from "@seedbase/client";

try {
  await client.getProject("missing");
} catch (err) {
  if (err instanceof SeedbaseError) {
    console.error(err.statusCode, err.message);
  }
}
```

## Links

- Website: https://seedba.se
- Docs: https://seedba.se/docs
- API keys: https://seedba.se/settings?tab=api-keys

MIT licensed.
