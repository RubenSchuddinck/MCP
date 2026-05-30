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

let webProcess: ChildProcess | null = null;

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

function safeWebPath(rel: string): string {
  const target = resolve(WEB_DIR, rel);
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) {
    throw new Error("Path escapes the web directory");
  }
  return target;
}

const FREEZER_DB = join(WEB_DIR, "data", "freezer.json");

type FreezerItem = {
  id: string;
  name: string;
  addedAt: string;
  portions: number;
  expiresInDays?: number;
};

async function readFreezerDB(): Promise<{ items: FreezerItem[] }> {
  try {
    const parsed = JSON.parse(await readFile(FREEZER_DB, "utf8"));
    return { items: parsed.items ?? [] };
  } catch {
    return { items: [] };
  }
}

async function writeFreezerDB(db: { items: FreezerItem[] }): Promise<void> {
  await writeFile(FREEZER_DB, JSON.stringify({ items: db.items }, null, 2));
}

function freezerItemStatus(item: FreezerItem): { status: string; remaining: number | null } {
  if (!item.expiresInDays) return { status: "no-expiry", remaining: null };
  const daysSince = (Date.now() - new Date(item.addedAt).getTime()) / 86400000;
  const remaining = item.expiresInDays - daysSince;
  if (remaining <= 0) return { status: "expired", remaining: Math.floor(remaining) };
  const threshold = Math.min(7, item.expiresInDays * 0.2);
  if (remaining <= threshold) return { status: "almost-spoiled", remaining: Math.floor(remaining) };
  return { status: "fresh", remaining: Math.floor(remaining) };
}

function formatFreezerItem(item: FreezerItem): string {
  const { status, remaining } = freezerItemStatus(item);
  const added = new Date(item.addedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const daysSince = Math.floor((Date.now() - new Date(item.addedAt).getTime()) / 86400000);
  const portionStr = `${item.portions} portion${item.portions !== 1 ? "s" : ""}`;
  const expiryStr = item.expiresInDays
    ? remaining !== null && remaining <= 0
      ? `, EXPIRED ${Math.abs(remaining)}d ago`
      : `, ${remaining}d remaining of ${item.expiresInDays}d`
    : ", no expiry set";
  const statusEmoji = status === "fresh" ? "✅" : status === "almost-spoiled" ? "⚠️" : status === "expired" ? "❌" : "🔵";
  return `${statusEmoji} ${item.name} — ${portionStr}, added ${added} (${daysSince}d ago)${expiryStr}`;
}

const REPO_DIR = resolve(__dirname, "..");
const MANIFEST = join(REPO_DIR, "servers.json");
const CADDYFILE = process.env.CADDYFILE || "/etc/caddy/Caddyfile";
const MCP_SERVICE = process.env.MCP_SERVICE || "mcp";

const webServers = new Map<string, ChildProcess>();

type ServerEntry = { name: string; entry: string; port: number; domain?: string; path?: string; start?: boolean };

async function readManifest(): Promise<ServerEntry[]> {
  try {
    const data = JSON.parse(await readFile(MANIFEST, "utf8"));
    return Array.isArray(data.servers) ? data.servers : [];
  } catch {
    return [];
  }
}

async function writeManifest(servers: ServerEntry[]): Promise<void> {
  await writeFile(MANIFEST, JSON.stringify({ servers }, null, 2) + "\n", "utf8");
}

function run(cmd: string, args: string[], cwd = REPO_DIR): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code: code ?? -1, out: out.trim() }));
    p.on("error", (e) => res({ code: -1, out: String(e) }));
  });
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const authCodes = new Set<string>();

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

  server.registerTool(
    "git_pull",
    {
      description: "Pull the latest changes for this repository (git pull --ff-only in the repo root).",
      inputSchema: {},
    },
    async () => {
      console.error("git_pull tool called");
      const { code, out } = await run("git", ["pull", "--ff-only"]);
      return text(`git pull exited ${code}\n\n${out || "(no output)"}`);
    }
  );

  server.registerTool(
    "start_all_webservers",
    {
      description:
        "Start every webserver listed in servers.json (entries with start:false are skipped). Already-running servers are left alone.",
      inputSchema: {},
    },
    async () => {
      console.error("start_all_webservers tool called");
      const servers = await readManifest();
      const startable = servers.filter((s) => s.start !== false);
      if (!startable.length) return text("No startable servers defined in servers.json.");
      const lines: string[] = [];
      for (const s of startable) {
        const existing = webServers.get(s.name);
        if (existing && existing.exitCode === null && !existing.killed) {
          lines.push(`${s.name}: already running (pid ${existing.pid})`);
          continue;
        }
        const entryPath = resolve(REPO_DIR, s.entry);
        if (entryPath !== REPO_DIR && !entryPath.startsWith(REPO_DIR + sep)) {
          lines.push(`${s.name}: entry '${s.entry}' escapes the repo, skipped`);
          continue;
        }
        const env = { ...process.env, WEB_PORT: String(s.port), PORT: String(s.port) };
        const proc = spawn(process.execPath, [entryPath], { cwd: REPO_DIR, env, stdio: "ignore" });
        proc.on("exit", () => {
          if (webServers.get(s.name) === proc) webServers.delete(s.name);
        });
        webServers.set(s.name, proc);
        await new Promise((r) => setTimeout(r, 300));
        lines.push(
          proc.exitCode === null
            ? `${s.name}: started (pid ${proc.pid}) on port ${s.port}`
            : `${s.name}: failed to start (port ${s.port} in use?)`
        );
      }
      return text(lines.join("\n"));
    }
  );

  server.registerTool(
    "register_webserver",
    {
      description:
        "Add or update a webserver in servers.json so it can be started and reverse-proxied. Run sync_caddy afterwards to publish the proxy.",
      inputSchema: {
        name: z.string().describe("Unique short name for the server"),
        entry: z.string().describe("Path to the entry file relative to repo root, e.g. 'web/server.mjs'"),
        port: z.number().describe("Local port the server listens on"),
        domain: z.string().optional().describe("Public domain for the Caddy reverse proxy, e.g. app.example.com"),
        path: z
          .string()
          .optional()
          .describe("Optional URL path prefix to mount under the domain, e.g. '/app1'. The prefix is stripped before proxying. Omit to serve at the domain root."),
      },
    },
    async ({ name, entry, port, domain, path }) => {
      console.error(`register_webserver tool called: ${name}`);
      const servers = await readManifest();
      const next: ServerEntry = { name, entry, port, ...(domain ? { domain } : {}), ...(path ? { path } : {}) };
      const idx = servers.findIndex((s) => s.name === name);
      if (idx >= 0) next.start = servers[idx].start;
      if (idx >= 0) servers[idx] = next;
      else servers.push(next);
      await writeManifest(servers);
      return text(
        `Registered '${name}' -> ${entry} on port ${port}${domain ? ` (domain ${domain})` : ""}.` +
          (domain ? " Run sync_caddy to publish the reverse proxy." : "")
      );
    }
  );

  server.registerTool(
    "sync_caddy",
    {
      description:
        "Regenerate the Caddyfile from servers.json (servers sharing a domain are merged into one site block, routed by path) and reload Caddy. Requires passwordless sudo for cp + systemctl.",
      inputSchema: {},
    },
    async () => {
      console.error("sync_caddy tool called");
      const servers = await readManifest();
      const withDomain = servers.filter((s) => s.domain);
      if (!withDomain.length) return text("No servers have a domain set; nothing to proxy.");

      const byDomain = new Map<string, ServerEntry[]>();
      for (const s of withDomain) {
        const arr = byDomain.get(s.domain!) ?? [];
        arr.push(s);
        byDomain.set(s.domain!, arr);
      }

      const blocks: string[] = [];
      for (const [domain, entries] of byDomain) {
        const pathed = entries.filter((e) => e.path);
        const roots = entries.filter((e) => !e.path);
        if (pathed.length === 0 && roots.length === 1) {
          blocks.push(`${domain} {\n    reverse_proxy localhost:${roots[0].port}\n}`);
          continue;
        }
        const inner: string[] = [];
        for (const e of pathed) {
          const p = e.path!.startsWith("/") ? e.path! : `/${e.path}`;
          inner.push(`    handle_path ${p}* {\n        reverse_proxy localhost:${e.port}\n    }`);
        }
        for (const e of roots) {
          inner.push(`    handle {\n        reverse_proxy localhost:${e.port}\n    }`);
        }
        blocks.push(`${domain} {\n${inner.join("\n\n")}\n}`);
      }
      const caddyfile = blocks.join("\n\n") + "\n";
      const tmp = join(REPO_DIR, ".Caddyfile.tmp");
      await writeFile(tmp, caddyfile, "utf8");
      const cp = await run("sudo", ["cp", tmp, CADDYFILE]);
      if (cp.code !== 0) {
        return text(
          `Generated the Caddyfile but failed to install it to ${CADDYFILE} (need passwordless sudo?):\n${cp.out}\n\n--- generated config ---\n${caddyfile}`
        );
      }
      const reload = await run("sudo", ["systemctl", "reload", "caddy"]);
      return text(
        `Caddyfile updated with ${blocks.length} site(s) and reloaded (exit ${reload.code}).\n${reload.out}\n\n--- config ---\n${caddyfile}`
      );
    }
  );

  server.registerTool(
    "list_freezer_items",
    {
      description: "List all items currently in the freezer, with their status (fresh / almost-spoiled / expired), portions, date added, and days remaining.",
      inputSchema: {},
    },
    async () => {
      const db = await readFreezerDB();
      if (!db.items.length) return text("The freezer is empty.");
      const lines = db.items.map(formatFreezerItem);
      const expiredCount = db.items.filter((i) => freezerItemStatus(i).status === "expired").length;
      const almostCount = db.items.filter((i) => freezerItemStatus(i).status === "almost-spoiled").length;
      const totalPortions = db.items.reduce((s, i) => s + i.portions, 0);
      const summary = `${db.items.length} item(s), ${totalPortions} total portion(s)${almostCount ? `, ⚠️ ${almostCount} almost spoiled` : ""}${expiredCount ? `, ❌ ${expiredCount} expired` : ""}`;
      return text(`${summary}\n\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "add_freezer_item",
    {
      description: "Add an item to the freezer inventory.",
      inputSchema: {
        name: z.string().describe("Name of the item, e.g. 'Chicken breasts'"),
        portions: z.number().optional().describe("Number of portions frozen (default 1)"),
        expiresInDays: z.number().optional().describe("How many days the item lasts in the freezer (from today). Omit if unknown."),
      },
    },
    async ({ name, portions, expiresInDays }) => {
      const item: FreezerItem = {
        id: randomUUID(),
        name: name.trim(),
        addedAt: new Date().toISOString(),
        portions: portions ?? 1,
        ...(expiresInDays != null ? { expiresInDays } : {}),
      };
      const db = await readFreezerDB();
      db.items.push(item);
      await writeFreezerDB(db);
      return text(`Added: ${formatFreezerItem(item)}`);
    }
  );

  server.registerTool(
    "remove_freezer_item",
    {
      description: "Remove an item from the freezer by its ID or by name (case-insensitive, first match).",
      inputSchema: {
        query: z.string().describe("The item ID or item name to remove"),
      },
    },
    async ({ query }) => {
      const db = await readFreezerDB();
      const q = query.trim();
      let idx = db.items.findIndex((i) => i.id === q);
      if (idx === -1) idx = db.items.findIndex((i) => i.name.toLowerCase() === q.toLowerCase());
      if (idx === -1) return text(`No item found matching "${q}". Use list_freezer_items to see current items.`);
      const [removed] = db.items.splice(idx, 1);
      await writeFreezerDB(db);
      return text(`Removed: ${removed.name} (${removed.portions} portion${removed.portions !== 1 ? "s" : ""})`);
    }
  );

  server.registerTool(
    "get_almost_spoiled_items",
    {
      description: "Get freezer items that are almost spoiled (<=7 days remaining or <=20% of shelf life left) or already expired.",
      inputSchema: {},
    },
    async () => {
      const db = await readFreezerDB();
      const flagged = db.items.filter((i) => {
        const { status } = freezerItemStatus(i);
        return status === "almost-spoiled" || status === "expired";
      });
      if (!flagged.length) return text("All freezer items are fresh (or have no expiry set). Nothing to worry about!");
      const lines = flagged.map(formatFreezerItem);
      return text(`${flagged.length} item(s) need attention:\n\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "restart_self",
    {
      description:
        "Rebuild the MCP server (npm run build) and restart it via systemd. The connection drops for a few seconds and systemd brings it back — reconnect afterwards. Requires the mcp.service unit + passwordless sudo (see install-mcp-service.sh).",
      inputSchema: {
        skipBuild: z.boolean().optional().describe("Skip 'npm run build' and just restart the service"),
      },
    },
    async ({ skipBuild }) => {
      console.error("restart_self tool called");
      if (!skipBuild) {
        const b = await run("npm", ["run", "build"]);
        if (b.code !== 0) return text(`Build failed (exit ${b.code}) — NOT restarting:\n${b.out}`);
      }
      const child = spawn("sudo", ["systemctl", "restart", "--no-block", MCP_SERVICE], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return text(
        `${skipBuild ? "" : "Build OK. "}Restarting '${MCP_SERVICE}' now — the connection will drop and return in a few seconds. Reconnect then.`
      );
    }
  );

  return server;
}

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
