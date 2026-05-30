import { createServer } from "http";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GAMES_PORT ? parseInt(process.env.GAMES_PORT) : 8084;
const DB = join(__dirname, "data", "games.json");

async function readDB() {
  return JSON.parse(await readFile(DB, "utf8"));
}

async function writeDB(data) {
  await writeFile(DB, JSON.stringify(data, null, 2));
}

createServer(async (req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];

  if (pathname === "/api/games") {
    if (req.method === "GET") {
      try {
        const data = await readDB();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch { res.writeHead(500).end("Server error"); }
      return;
    }
    if (req.method === "PUT") {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body);
        await writeDB(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) { res.writeHead(400).end(e.message); }
      return;
    }
  }

  try {
    const content = await readFile(join(__dirname, "games.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  } catch { res.writeHead(500).end("Server error"); }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Games tracker running on http://0.0.0.0:${PORT}`);
});
