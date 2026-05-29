import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { spawn, ChildProcess } from "child_process";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join, relative, resolve, sep } from "path";
import { z } from "zod";

process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, "..", "web");

// Tracks the running webpage process (persists across stateless MCP requests)
let webProcess: ChildProcess | null = null;

// Recursively list files under WEB_DIR, returning paths relative to WEB_DIR
async function listWebFiles(dir = WEB_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await listWebFiles(full)));
    else files.push(relative(WEB_DIR, full));
  }
  return files;
}

// Resolve a user-supplied relative path safely inside WEB_DIR (blocks traversal)
function safeWebPath(rel: string): string {
  const target = resolve(WEB_DIR, rel);
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) {
    throw new Error("Path escapes the web directory");
  }
  return target;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const authCodes = new Set<string>();

// --- OAuth (claude.ai requires this discovery dance; we auto-approve) ---
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({ resource: BASE_URL, authorization_servers: [BASE_URL] });
});
app.get("/.well-known/oauth-protected-resource/sse", (req, res) => {
  res.json({ resource: `${BASE_URL}/sse`, authorization_servers: [BASE_URL] });
});
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});
app.post("/register", (req, res) => {
  res.json({ client_id: randomUUID(), redirect_uris: req.body.redirect_uris || [] });
});
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query as Record<string, string>;
  const code = randomUUID();
  authCodes.add(code);
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});
app.post("/token", (req, res) => {
  if (!authCodes.delete(req.body.code)) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  res.json({ access_token: randomUUID(), token_type: "Bearer" });
});

// --- MCP server factory ---
function createServer() {
  const server = new McpServer({ name: "my-mcp-server", version: "1.0.0" });
  server.registerTool(
    "greet",
    {
      description: "Greet a person by name",
      inputSchema: { name: z.string().describe("The person's name") },
    },
    async ({ name }) => {
      console.error(`greet tool called with name: ${name}`);
      return { content: [{ type: "text", text: `Hello, ${name}!` }] };
    }
  );

  server.registerTool(
    "list_ngrok_tunnels",
    {
      description: "List the currently active ngrok tunnels and their public URLs",
      inputSchema: {},
    },
    async () => {
      console.error("list_ngrok_tunnels tool called");
      try {
        const r = await fetch("http://127.0.0.1:4040/api/tunnels");
        if (!r.ok) throw new Error(`ngrok API returned ${r.status}`);
        const data = (await r.json()) as { tunnels: { public_url: string; config: { addr: string } }[] };
        if (!data.tunnels.length) {
          return { content: [{ type: "text", text: "No active ngrok tunnels." }] };
        }
        const lines = data.tunnels.map((t) => `${t.public_url} -> ${t.config.addr}`).join("\n");
        return { content: [{ type: "text", text: lines }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not reach ngrok API (is ngrok running?): ${String(e)}` }] };
      }
    }
  );

  server.registerTool(
    "start_webserver",
    {
      description: "Start the static webpage server (web/server.mjs). Returns its status.",
      inputSchema: {
        port: z.number().optional().describe("Port to run on (default 8080)"),
      },
    },
    async ({ port }) => {
      if (webProcess && !webProcess.killed && webProcess.exitCode === null) {
        return { content: [{ type: "text", text: "Webserver is already running." }] };
      }
      const serverPath = join(WEB_DIR, "server.mjs");
      const env = { ...process.env };
      if (port) env.WEB_PORT = String(port);
      webProcess = spawn(process.execPath, [serverPath], { env, stdio: "ignore" });
      webProcess.on("exit", () => { webProcess = null; });
      await new Promise((r) => setTimeout(r, 300));
      if (!webProcess || webProcess.exitCode !== null) {
        return { content: [{ type: "text", text: "Webserver failed to start (port in use?)." }] };
      }
      return { content: [{ type: "text", text: `Webserver started (pid ${webProcess.pid}) on port ${port ?? 8080}.` }] };
    }
  );

  server.registerTool(
    "get_webserver_files",
    {
      description: "Retrieve all files served by the webserver, with their contents.",
      inputSchema: {},
    },
    async () => {
      try {
        const files = await listWebFiles();
        const parts = await Promise.all(
          files.map(async (f) => {
            const body = await readFile(join(WEB_DIR, f), "utf8");
            return `===== ${f} =====\n${body}`;
          })
        );
        return { content: [{ type: "text", text: parts.join("\n\n") || "(web directory is empty)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error reading web files: ${String(e)}` }] };
      }
    }
  );

  server.registerTool(
    "upload_webserver_file",
    {
      description: "Create or overwrite a file in the webserver directory with new content.",
      inputSchema: {
        path: z.string().describe("File path relative to the web directory, e.g. 'index.html'"),
        content: z.string().describe("Full new content of the file"),
      },
    },
    async ({ path, content }) => {
      try {
        const target = safeWebPath(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        return { content: [{ type: "text", text: `Wrote ${content.length} bytes to ${path}. Restart the webserver if it was already running.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error writing file: ${String(e)}` }] };
      }
    }
  );

  return server;
}

// --- Single Streamable HTTP endpoint, stateless: fresh server+transport per request ---
async function handleMcp(req: Request, res: Response) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post("/sse", handleMcp);
app.get("/sse", handleMcp);
app.delete("/sse", handleMcp);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on http://0.0.0.0:${PORT}`);
});
