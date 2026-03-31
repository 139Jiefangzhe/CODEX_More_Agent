import path from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

export function hello(name: string) {
  return `hello ${name}`;
}

export function requestHandler(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET" && req.url === "/health") {
    const body = JSON.stringify({ status: "ok" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
    return;
  }

  const body = JSON.stringify({ error: "Not Found" });
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

export function createAppServer() {
  return createServer(requestHandler);
}

function getPort() {
  const raw = process.env.PORT;
  if (!raw) return 3000;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3000;
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedPath === currentFilePath) {
  const port = getPort();
  const server = createAppServer();
  server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}
