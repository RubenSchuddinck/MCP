import { createServer } from "http";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PLAY_GAMES_PORT ? parseInt(process.env.PLAY_GAMES_PORT) : 8085;

createServer(async (_req, res) => {
  try {
    const content = await readFile(join(__dirname, "play-games.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  } catch {
    res.writeHead(500).end("Server error");
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Games running on http://0.0.0.0:${PORT}`);
});
