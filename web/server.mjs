import { createServer } from "http";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join, extname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : 8080;
const DB = join(__dirname, "data", "recipes.json");

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

// recipes.json is stored as { "recipes": [...] }. Read returns the bare
// array; write wraps it back up so the on-disk shape stays consistent.
async function readDB() {
  const parsed = JSON.parse(await readFile(DB, "utf8"));
  return Array.isArray(parsed) ? parsed : (parsed.recipes ?? []);
}

async function writeDB(recipes) {
  await writeFile(DB, JSON.stringify({ recipes }, null, 2));
}

function resolveFile(pathname) {
  const clean = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  if (clean === "/") return "index.html";
  if (clean === "/cooking") return "cooking.html";
  if (clean.startsWith("/data/")) return clean.slice(1);
  return null;
}

createServer(async (req, res) => {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method;

  // ── API ───────────────────────────────────────────────────────────────────────
  if (pathname === "/api/recipes") {
    if (method === "GET") {
      try {
        const recipes = await readDB();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(recipes));
      } catch { res.writeHead(500).end("Server error"); }
      return;
    }
    if (method === "POST") {
      try {
        const recipe = await readBody(req);
        const recipes = await readDB();
        recipes.push(recipe);
        await writeDB(recipes);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(recipe));
      } catch (e) { res.writeHead(400).end(e.message); }
      return;
    }
  }

  const idMatch = pathname.match(/^\/api\/recipes\/(.+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === "PUT") {
      try {
        const recipe = await readBody(req);
        const recipes = await readDB();
        const idx = recipes.findIndex((r) => r.id === id);
        if (idx === -1) { res.writeHead(404).end("Not found"); return; }
        recipes[idx] = recipe;
        await writeDB(recipes);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(recipe));
      } catch (e) { res.writeHead(400).end(e.message); }
      return;
    }
    if (method === "DELETE") {
      try {
        let recipes = await readDB();
        const before = recipes.length;
        recipes = recipes.filter((r) => r.id !== id);
        if (recipes.length === before) { res.writeHead(404).end("Not found"); return; }
        await writeDB(recipes);
        res.writeHead(204).end();
      } catch { res.writeHead(500).end("Server error"); }
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
  console.log(`Webpage running on http://0.0.0.0:${PORT}`);
});
