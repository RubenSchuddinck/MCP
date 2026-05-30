import { createServer } from "http";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : (process.env.PORT ? parseInt(process.env.PORT) : 8086);
const DB = join(__dirname, "data", "freezer.json");

async function readDB() {
  try {
    const parsed = JSON.parse(await readFile(DB, "utf8"));
    return { items: parsed.items ?? [] };
  } catch {
    return { items: [] };
  }
}

async function writeDB(db) {
  await writeFile(DB, JSON.stringify({ items: db.items }, null, 2));
}

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

function itemStatus(item) {
  if (!item.expiresInDays) return { status: "no-expiry", remaining: null };
  const daysSince = (Date.now() - new Date(item.addedAt).getTime()) / 86400000;
  const remaining = item.expiresInDays - daysSince;
  if (remaining <= 0) return { status: "expired", remaining: Math.floor(remaining) };
  const threshold = Math.min(7, item.expiresInDays * 0.2);
  if (remaining <= threshold) return { status: "almost-spoiled", remaining: Math.floor(remaining) };
  return { status: "fresh", remaining: Math.floor(remaining) };
}

createServer(async (req, res) => {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method;

  if (pathname === "/api/freezer" && method === "GET") {
    try {
      const db = await readDB();
      const items = db.items.map((item) => ({ ...item, ...itemStatus(item) }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(items));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  if (pathname === "/api/freezer" && method === "POST") {
    try {
      const body = await readBody(req);
      if (!body.name || typeof body.name !== "string") {
        res.writeHead(400).end("name is required");
        return;
      }
      const item = {
        id: randomUUID(),
        name: body.name.trim(),
        addedAt: new Date().toISOString(),
        portions: body.portions != null ? Number(body.portions) : 1,
        ...(body.expiresInDays != null ? { expiresInDays: Number(body.expiresInDays) } : {}),
      };
      const db = await readDB();
      db.items.push(item);
      await writeDB(db);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...item, ...itemStatus(item) }));
    } catch (e) { res.writeHead(400).end(e.message); }
    return;
  }

  const putMatch = pathname.match(/^\/api\/freezer\/(.+)$/);
  if (putMatch && method === "PUT") {
    try {
      const id = putMatch[1];
      const body = await readBody(req);
      const db = await readDB();
      const idx = db.items.findIndex((i) => i.id === id);
      if (idx === -1) { res.writeHead(404).end("Not found"); return; }
      db.items[idx] = { ...db.items[idx], ...body, id };
      await writeDB(db);
      const item = db.items[idx];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...item, ...itemStatus(item) }));
    } catch (e) { res.writeHead(400).end(e.message); }
    return;
  }

  const delMatch = pathname.match(/^\/api\/freezer\/(.+)$/);
  if (delMatch && method === "DELETE") {
    try {
      const id = delMatch[1];
      const db = await readDB();
      const idx = db.items.findIndex((i) => i.id === id);
      if (idx === -1) { res.writeHead(404).end("Not found"); return; }
      const [removed] = db.items.splice(idx, 1);
      await writeDB(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(removed));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  try {
    if (pathname === "/" || pathname === "") {
      const content = await readFile(join(__dirname, "freezer.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    } else {
      res.writeHead(500).end("Server error");
    }
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Freezer tracker running on http://0.0.0.0:${PORT}`);
});
