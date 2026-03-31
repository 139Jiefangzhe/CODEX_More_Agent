# Todo Demo

A tiny TypeScript/Node demo project for Multi-Agent Dashboard end-to-end validation.

## What this demo provides

- `hello(name)` utility export (kept for compatibility)
- A minimal HTTP server using Node native `http` module
- `GET /health` endpoint for quick health checks

## Run

This repository currently keeps scripts minimal and does not add extra runtime dependencies.

- Build check:

```bash
npm run build
```

- Start server (using TypeScript entry directly requires your environment to support TS execution, e.g. via your tooling):

```bash
PORT=3000 node src/index.ts
```

If `PORT` is not provided, default port is `3000`.

## API

### `GET /health`

- Status: `200 OK`
- Response:

```json
{
  "status": "ok"
}
```

### Unknown paths

- Status: `404 Not Found`
- Response:

```json
{
  "error": "Not Found"
}
```

## Quick verification with curl

```bash
curl -i http://localhost:3000/health
```

Expected status line includes `200` and body contains `{"status":"ok"}`.

```bash
curl -i http://localhost:3000/not-found
```

Expected status line includes `404` and body contains `{"error":"Not Found"}`.