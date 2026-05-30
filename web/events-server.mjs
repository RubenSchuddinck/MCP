import { createServer } from "http";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : (process.env.PORT ? parseInt(process.env.PORT) : 8088);
const DB = join(__dirname, "data", "events.json");

async function readDB() {
  try {
    const parsed = JSON.parse(await readFile(DB, "utf8"));
    return { events: parsed.events ?? [] };
  } catch {
    return { events: [] };
  }
}

async function writeDB(db) {
  await writeFile(DB, JSON.stringify({ events: db.events }, null, 2));
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

createServer(async (req, res) => {
  const url = req.url ?? "/";
  const [rawPath, qs] = url.split("?");
  const pathname = rawPath.replace(/\/+$/, "") || "/";
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders).end();
    return;
  }

  if (pathname === "/api/events" && method === "GET") {
    try {
      const db = await readDB();
      let events = db.events;
      const params = new URLSearchParams(qs ?? "");
      const type = params.get("type");
      const tag = params.get("tag");
      const intensity = params.get("intensity");
      const today = new Date().toISOString().slice(0, 10);
      if (type === "past") events = events.filter(e => e.startDate < today);
      else if (type === "future") events = events.filter(e => e.startDate >= today);
      if (tag) events = events.filter(e => e.tags?.some(t => t.toLowerCase() === tag.toLowerCase()));
      if (intensity) events = events.filter(e => e.intensity === intensity);
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(events));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  if (pathname === "/api/events" && method === "POST") {
    try {
      const body = await readBody(req);
      if (!body.name?.trim()) { res.writeHead(400).end("name is required"); return; }
      if (!body.startDate) { res.writeHead(400).end("startDate is required (YYYY-MM-DD)"); return; }
      const now = new Date().toISOString();
      const event = {
        id: randomUUID(),
        name: body.name.trim(),
        startDate: body.startDate,
        ...(body.endDate ? { endDate: body.endDate } : {}),
        ...(body.description ? { description: String(body.description).trim() } : {}),
        ...(body.rating != null ? { rating: Number(body.rating) } : {}),
        ...(body.review ? { review: String(body.review).trim() } : {}),
        ...(Array.isArray(body.tags) && body.tags.length ? { tags: body.tags } : {}),
        ...(body.intensity ? { intensity: body.intensity } : {}),
        ...(Array.isArray(body.vibes) && body.vibes.length ? { vibes: body.vibes } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const db = await readDB();
      db.events.push(event);
      await writeDB(db);
      res.writeHead(201, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(event));
    } catch (e) { res.writeHead(400).end(e.message); }
    return;
  }

  const idMatch = pathname.match(/^\/api\/events\/(.+)$/);

  if (idMatch && method === "GET") {
    try {
      const db = await readDB();
      const event = db.events.find(e => e.id === idMatch[1]);
      if (!event) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(event));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  if (idMatch && method === "PUT") {
    try {
      const body = await readBody(req);
      const db = await readDB();
      const idx = db.events.findIndex(e => e.id === idMatch[1]);
      if (idx === -1) { res.writeHead(404).end("Not found"); return; }
      db.events[idx] = { ...db.events[idx], ...body, id: idMatch[1], updatedAt: new Date().toISOString() };
      await writeDB(db);
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(db.events[idx]));
    } catch (e) { res.writeHead(400).end(e.message); }
    return;
  }

  if (idMatch && method === "DELETE") {
    try {
      const db = await readDB();
      const idx = db.events.findIndex(e => e.id === idMatch[1]);
      if (idx === -1) { res.writeHead(404).end("Not found"); return; }
      const [removed] = db.events.splice(idx, 1);
      await writeDB(db);
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(removed));
    } catch { res.writeHead(500).end("Server error"); }
    return;
  }

  try {
    if (pathname === "/" || pathname === "") {
      const content = await readFile(join(__dirname, "events.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404).end("Not found");
    } else {
      res.writeHead(500).end("Server error");
    }
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Event tracker running on http://0.0.0.0:${PORT}`);
});
