import { createServer } from "http";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join, extname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function resolveFile(pathname) {
  const clean = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  if (clean === "/") return "index.html";
  if (clean === "/cooking") return "cooking.html";
  if (clean.startsWith("/data/")) return clean.slice(1); // strip leading slash
  return null;
}

createServer(async (req, res) => {
  try {
    const file = resolveFile(req.url ?? "/");
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const content = await readFile(join(__dirname, file));
    const mime = MIME[extname(file)] ?? "text/plain";
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    } else {
      res.writeHead(500).end("Server error");
    }
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Webpage running on http://0.0.0.0:${PORT}`);
});
