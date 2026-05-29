import { createServer } from "http";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join, extname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : 8083;
const DB = join(__dirname, "data", "onepiece.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// onepiece.json is stored as { "arcs": [...] }. Read returns the bare array;
// write wraps it back up so the on-disk shape stays consistent.
async function readDB() {
  const parsed = JSON.parse(await readFile(DB, "utf8"));
  return Array.isArray(parsed) ? parsed : (parsed.arcs ?? []);
}

async function writeDB(arcs) {
  await writeFile(DB, JSON.stringify({ arcs }, null, 2));
}

// Keep watchedCount a sane integer within [0, epCount].
function clampWatched(arc) {
  const max = Number(arc.epCount) || 0;
  let n = Number(arc.watchedCount) || 0;
  if (n < 0) n = 0;
  if (n > max) n = max;
  arc.watchedCount = n;
  return arc;
}

function resolveFile(pathname) {
  const clean = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  if (clean === "/") return "onepiece.html";
  if (clean.startsWith("/data/")) return clean.slice(1);
  return null;
}

createServer(async (req, res) => {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method;

  // ── API ───────────────────────────────────────────────────────────────────────
  if (pathname === "/api/onepiece") {
    if (method === "GET") {
      try {
        const arcs = await readDB();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(arcs));
      } catch { res.writeHead(500).end("Server error"); }
      return;
    }
  }

  if (pathname === "/api/onepiece/reset" && method === "POST") {
    try {
      const arcs = await readDB();
      arcs.forEach((a) => (a.watchedCount = 0));
      await writeDB(arcs);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(arcs));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  const idMatch = pathname.match(/^\/api\/onepiece\/(.+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === "PUT") {
      try {
        const incoming = await readBody(req);
        const arcs = await readDB();
        const idx = arcs.findIndex((a) => a.id === id);
        if (idx === -1) { res.writeHead(404).end("Not found"); return; }
        // Merge so canonical fields (epStart/epEnd/epCount) can't be lost.
        const arc = clampWatched({ ...arcs[idx], ...incoming, id });
        arcs[idx] = arc;
        await writeDB(arcs);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(arc));
      } catch (e) { res.writeHead(400).end(e.message); }
      return;
    }
  }

  // ── Static files ──────────────────────────────────────────────────────────────
  try {
    const file = resolveFile(url);
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
  console.log(`One Piece tracker running on http://0.0.0.0:${PORT}`);
});
