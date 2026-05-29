import { createServer } from "http";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : 8080;

createServer(async (req, res) => {
  try {
    const html = await readFile(join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } catch {
    res.writeHead(500).end("error");
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Webpage running on http://0.0.0.0:${PORT}`);
});
