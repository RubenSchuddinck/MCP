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

// onepiece.json holds { "arcs": [...], "log": [...] }. The log is an
// append-only history of watch events (date + arc + episodes), kept for a
// future dashboard. readDB returns the whole object; writeDB persists it so
// the log is never dropped on a write. (Legacy bare-array files still load.)
async function readDB() {
  const parsed = JSON.parse(await readFile(DB, "utf8"));
  if (Array.isArray(parsed)) return { arcs: parsed, log: [] };
  return { arcs: parsed.arcs ?? [], log: parsed.log ?? [] };
}

async function writeDB(db) {
  await writeFile(DB, JSON.stringify({ arcs: db.arcs, log: db.log }, null, 2));
}

// Build a log entry describing a watchedCount change for a single arc.
function logEntry(arc, prev, next, totalAfter) {
  const e = { ts: new Date().toISOString(), arcId: arc.id, arcName: arc.name,
    prevCount: prev, newCount: next, delta: next - prev, totalWatchedAfter: totalAfter };
  if (next > prev) e.episodesWatched = [arc.epStart + prev, arc.epStart + next - 1];
  return e;
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
        const db = await readDB();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(db.arcs));
      } catch { res.writeHead(500).end("Server error"); }
      return;
    }
  }

  // Watch history (date + arc + episodes) for dashboards.
  if (pathname === "/api/onepiece/log" && method === "GET") {
    try {
      const db = await readDB();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(db.log));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  if (pathname === "/api/onepiece/reset" && method === "POST") {
    try {
      const db = await readDB();
      db.arcs.forEach((a) => (a.watchedCount = 0));
      db.log.push({ ts: new Date().toISOString(), type: "reset" });
      await writeDB(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(db.arcs));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  const idMatch = pathname.match(/^\/api\/onepiece\/(.+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === "PUT") {
      try {
        const incoming = await readBody(req);
        const db = await readDB();
        const idx = db.arcs.findIndex((a) => a.id === id);
        if (idx === -1) { res.writeHead(404).end("Not found"); return; }
        const prev = Number(db.arcs[idx].watchedCount) || 0;
        // Merge so canonical fields (epStart/epEnd/epCount) can't be lost.
        const arc = clampWatched({ ...db.arcs[idx], ...incoming, id });
        db.arcs[idx] = arc;
        // Record the change so we know what was watched (or unwatched) when.
        if (arc.watchedCount !== prev) {
          const total = db.arcs.reduce((n, a) => n + (Number(a.watchedCount) || 0), 0);
          db.log.push(logEntry(arc, prev, arc.watchedCount, total));
        }
        await writeDB(db);
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
