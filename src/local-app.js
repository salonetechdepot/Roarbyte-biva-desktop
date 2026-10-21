/**
 * Serves BIVA on this computer.
 * While the internet works, pages and API answers are saved here.
 * Without the internet, those saved pages and the SQLite data keep the whole app usable.
 * Local changes wait in the outbox until the computer is online, then they are sent to the cloud.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const routes = require("./app-routes.json");

const PORT = 47321;
const MAX_BODY = 32 * 1024 * 1024;

function describeChange(method, urlPath) {
  const root = urlPath.split("?")[0].replace(/^\/api\/proxy\/?/i, "").replace(/^\/api\//i, "").split("/").filter(Boolean)[0] || "record";
  const label = root.replace(/-/g, " ");
  const verb = method === "POST" ? "Add" : method === "DELETE" ? "Remove" : method === "PUT" || method === "PATCH" ? "Update" : method;
  return `${verb} ${label}`;
}

function safeFile(root, urlPath, variant) {
  const [pathname, search = ""] = (urlPath || "/").split("?");
  const cleaned = pathname.replace(/\\/g, "/").replace(/\.\./g, "");
  const leaf = cleaned === "/" ? "index" : cleaned.replace(/^\/+/, "");
  const query = search ? "__" + Buffer.from(search).toString("base64url").slice(0, 48) : "";
  return path.join(root, variant, leaf + query);
}

function findSaved(mirror, urlPath, variant, authed) {
  const folders = [];
  const add = (name) => {
    if (!folders.includes(name)) folders.push(name);
  };
  if (urlPath.startsWith("/_next/")) add("asset-anon");
  else {
    add(`${variant}-${authed ? "auth" : "anon"}`);
    add(`${variant}-${authed ? "anon" : "auth"}`);
    add("document-auth");
    add("document-anon");
  }
  for (const folder of folders) {
    const exact = readMirror(safeFile(mirror, urlPath, folder));
    if (exact) return exact;
    if (urlPath.includes("?")) {
      const bare = readMirror(safeFile(mirror, urlPath.split("?")[0], folder));
      if (bare) return bare;
    }
  }
  return null;
}

function readMirror(file) {
  const bodyFile = file + ".body";
  const metaFile = file + ".meta.json";
  if (!fs.existsSync(bodyFile) || !fs.existsSync(metaFile)) return null;
  return {
    body: fs.readFileSync(bodyFile),
    meta: JSON.parse(fs.readFileSync(metaFile, "utf8")),
  };
}

function writeMirror(file, body, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".body", body);
  fs.writeFileSync(file + ".meta.json", JSON.stringify(meta));
}

function variantOf(req) {
  if (req.headers.rsc === "1") return req.headers["next-router-prefetch"] ? "prefetch" : "rsc";
  return "document";
}

function hasSession(req) {
  return String(req.headers.cookie || "").includes("inventory_access_token");
}

function rewriteBody(body, contentType, fromOrigin, toOrigin) {
  const type = contentType || "";
  const text = type.includes("text/") || type.includes("javascript") || type.includes("json") || type.includes("xml");
  if (!text) return body;
  const source = body.toString("utf8");
  if (!source.includes(fromOrigin)) return body;
  return Buffer.from(source.split(fromOrigin).join(toOrigin));
}

function rewriteSetCookie(cookie) {
  return cookie
    .replace(/;\s*Domain=[^;]*/gi, "")
    .replace(/;\s*Secure/gi, "")
    .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
}

function forwardHeaders(req) {
  const headers = {
    accept: req.headers.accept || "*/*",
    "accept-language": req.headers["accept-language"] || "en",
    "user-agent": req.headers["user-agent"] || "BIVA-Desktop",
    "accept-encoding": "identity",
  };
  for (const name of ["cookie", "authorization", "content-type", "rsc", "next-url", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  return headers;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Upload is too large to store on this computer."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, headers) {
  res.writeHead(status, headers);
  res.end(body);
}

function setupPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>BIVA</title></head>
<body style="font-family:Segoe UI,sans-serif;background:#fbf6e8;color:#12345B;display:grid;place-items:center;height:100vh;margin:0">
<main style="max-width:420px;background:#fff;border-radius:20px;padding:32px;text-align:center">
<h1>Connect once to set up BIVA</h1>
<p>The first time this computer opens BIVA it downloads the whole app and your business. After that, every screen works offline and syncs when you are back online.</p>
</main></body></html>`;
}

function startLocalApp({ upstream, db, mirrorDir }) {
  return new Promise((resolve, reject) => {
    const origin = upstream.replace(/\/+$/, "");
    let localOrigin = "";
    const mirror = mirrorDir;
    let onlineCache = { at: 0, value: false };
    let warming = false;

    async function isOnline(force) {
      if (!force && Date.now() - onlineCache.at < 8000) return onlineCache.value;
      try {
        const response = await fetch(origin + "/account/login", { method: "GET", redirect: "manual", signal: AbortSignal.timeout(3000) });
        onlineCache = { at: Date.now(), value: response.status > 0 };
      } catch {
        onlineCache = { at: Date.now(), value: false };
      }
      return onlineCache.value;
    }

    async function pull(urlPath, headers) {
      const response = await fetch(origin + urlPath, {
        method: "GET",
        headers: { ...headers, "accept-encoding": "identity" },
        redirect: "follow",
        signal: AbortSignal.timeout(60000),
      });
      return { response, body: Buffer.from(await response.arrayBuffer()) };
    }

    function storeGet(urlPath, variant, authed, response, body) {
      const type = response.headers.get("content-type") || "application/octet-stream";
      const rewritten = rewriteBody(body, type, origin, localOrigin);
      const folder = urlPath.startsWith("/_next/") ? "asset-anon" : `${variant}-${authed ? "auth" : "anon"}`;
      if (response.ok) writeMirror(safeFile(mirror, urlPath, folder), rewritten, { status: response.status, contentType: type });
      if (urlPath.split("?")[0].startsWith("/api/") && response.ok && type.includes("json") && db) {
        db.writeCache(`GET ${urlPath.split("?")[0]}`, response.status, rewritten.toString("utf8"));
      }
      return rewritten;
    }

    async function warm(cookie) {
      if (warming || !db) return;
      warming = true;
      db.setMeta("uiReady", "running");
      const headers = { accept: "text/html,application/xhtml+xml", cookie: cookie || "" };
      const collections = [
        "products", "customers", "suppliers", "categories", "sub-categories", "warehouses", "sales", "sale-lines",
        "receipts", "employees", "departments", "expenses", "incomes", "modules", "pos-registers", "cashiers",
        "shifts", "holidays", "leaves",
      ];
      try {
        let savedLists = 0;
        for (const name of collections) {
          if (!(await isOnline(true))) break;
          try {
            const list = await pull(`/api/proxy/api/${name}`, { accept: "application/json", cookie: cookie || "" });
            if (list.response.ok) {
              storeGet(`/api/proxy/api/${name}`, "document", true, list.response, list.body);
              savedLists += 1;
            }
          } catch {
            // This list is not available for every account.
          }
        }
        if (savedLists > 0) db.setMeta("seeded", new Date().toISOString());
        for (const route of routes) {
          if (!(await isOnline(true))) break;
          try {
            const document = await pull(route, headers);
            const body = storeGet(route, "document", Boolean(cookie), document.response, document.body);
            const assets = new Set();
            for (const match of body.toString("utf8").matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)) assets.add(match[1]);
            for (const asset of assets) {
              const saved = await pull(asset, { accept: "*/*" });
              storeGet(asset.split("?")[0], "asset", false, saved.response, saved.body);
            }
            const flight = await pull(route, { ...headers, rsc: "1", "next-router-prefetch": "1", accept: "*/*" });
            storeGet(route, "prefetch", Boolean(cookie), flight.response, flight.body);
          } catch {
            // Keep saving the other screens.
          }
        }
        if (await isOnline()) db.setMeta("uiReady", new Date().toISOString());
        else if (db.getMeta("uiReady") === "running") db.setMeta("uiReady", "");
      } finally {
        warming = false;
      }
    }

    async function syncNow(cookie) {
      const failed = [];
      for (const change of db.status().pending) {
        try {
          const headers = { accept: "application/json", "accept-encoding": "identity" };
          if (change.contentType) headers["content-type"] = change.contentType;
          if (cookie) headers.cookie = cookie;
          try {
            const stored = change.headers ? JSON.parse(change.headers) : {};
            if (stored.authorization) headers.authorization = stored.authorization;
            if (stored.cookie) headers.cookie = stored.cookie;
          } catch {
            // Continue without the saved header.
          }
          const encoding = change.encoding === "base64" ? "base64" : "utf8";
          const response = await fetch(origin + change.path, {
            method: change.method,
            headers,
            body: change.body ? Buffer.from(change.body, encoding) : undefined,
            signal: AbortSignal.timeout(60000),
          });
          if (!response.ok && response.status !== 409) {
            failed.push({ id: change.id, summary: change.summary, message: `Cloud returned ${response.status}` });
            continue;
          }
          db.drop(change.id);
        } catch (error) {
          failed.push({ id: change.id, summary: change.summary, message: error instanceof Error ? error.message : "Could not send this change." });
        }
      }
      if (await isOnline(true)) {
        for (const key of db.listCacheKeys()) {
          if (!String(key).startsWith("GET /api/")) continue;
          try {
            const saved = await pull(String(key).slice(4), { accept: "application/json", cookie: cookie || "" });
            if (saved.response.ok) storeGet(String(key).slice(4), "document", true, saved.response, saved.body);
          } catch {
            // Keep the saved copy.
          }
        }
      }
      if (failed.length === 0) db.markSynced();
      return { ...db.status(), online: await isOnline(), uiReady: db.getMeta("uiReady"), failed };
    }

    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = req.url || "/";
        if (!db) {
          send(res, 500, "Offline storage is not ready.", { "content-type": "text/plain" });
          return;
        }
        if (hasSession(req) && !db.getMeta("uiReady")) void warm(String(req.headers.cookie || ""));
        if (urlPath.startsWith("/__biva/sync") && req.method === "GET") {
          send(res, 200, JSON.stringify({ ...db.status(), online: await isOnline(), uiReady: db.getMeta("uiReady") }), { "content-type": "application/json" });
          return;
        }
        if (urlPath.startsWith("/__biva/sync") && req.method === "POST") {
          send(res, 200, JSON.stringify(await syncNow(req.headers.cookie || "")), { "content-type": "application/json" });
          return;
        }
        if (urlPath.startsWith("/__biva/warm") && req.method === "POST") {
          void warm(String(req.headers.cookie || ""));
          send(res, 202, JSON.stringify({ started: true, routes: routes.length }), { "content-type": "application/json" });
          return;
        }

        const method = (req.method || "GET").toUpperCase();
        const variant = variantOf(req);
        const authed = hasSession(req);

        if (method !== "GET" && method !== "HEAD") {
          const body = await readRequestBody(req);
          if (!(await isOnline()) && urlPath.startsWith("/api/")) {
            const multipart = String(req.headers["content-type"] || "").includes("multipart");
            const id = randomUUID();
            db.enqueue({
              id,
              method,
              path: urlPath,
              body: multipart ? body.toString("base64") : body.toString("utf8"),
              encoding: multipart ? "base64" : "utf8",
              contentType: req.headers["content-type"] || "application/json",
              headers: JSON.stringify({ authorization: req.headers.authorization || "", cookie: req.headers.cookie || "" }),
              summary: describeChange(method, urlPath),
              createdAt: new Date().toISOString(),
            });
            send(res, 202, JSON.stringify({ id, offlineQueued: true }), { "content-type": "application/json" });
            return;
          }
          const response = await fetch(origin + urlPath, {
            method,
            headers: forwardHeaders(req),
            body: body.length ? body : undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(90000),
          });
          const payload = Buffer.from(await response.arrayBuffer());
          const headers = { "content-type": response.headers.get("content-type") || "application/json" };
          const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
          if (cookies.length) headers["set-cookie"] = cookies.map(rewriteSetCookie);
          send(res, response.status, payload, headers);
          return;
        }

        if (await isOnline()) {
          try {
            const response = await fetch(origin + urlPath, {
              method: "GET",
              headers: forwardHeaders(req),
              redirect: "follow",
              signal: AbortSignal.timeout(90000),
            });
            const raw = Buffer.from(await response.arrayBuffer());
            const type = response.headers.get("content-type") || "application/octet-stream";
            const body = storeGet(urlPath, urlPath.startsWith("/_next/") ? "asset" : variant, urlPath.startsWith("/_next/") ? false : authed, response, raw);
            const headers = { "content-type": type };
            const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
            if (cookies.length) headers["set-cookie"] = cookies.map(rewriteSetCookie);
            send(res, response.status, body, headers);
            return;
          } catch {
            onlineCache = { at: Date.now(), value: false };
          }
        }

        const saved = findSaved(mirror, urlPath, variant, authed);
        if (saved) {
          send(res, saved.meta.status || 200, saved.body, { "content-type": saved.meta.contentType || "text/html" });
          return;
        }
        if (urlPath.startsWith("/api/")) {
          const row = db.read(`GET ${urlPath.split("?")[0]}`);
          if (row) {
            send(res, row.status || 200, row.body, { "content-type": "application/json" });
            return;
          }
          send(res, 503, JSON.stringify({ title: "Not on this computer yet", detail: "Connect to the internet once so BIVA can download this." }), {
            "content-type": "application/json",
          });
          return;
        }
        send(res, 503, setupPage(), { "content-type": "text/html; charset=utf-8" });
      } catch (error) {
        if (!res.headersSent) send(res, 500, error instanceof Error ? error.message : "BIVA could not open this screen.", { "content-type": "text/plain" });
      }
    });

    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      localOrigin = `http://127.0.0.1:${PORT}`;
      setInterval(() => {
        if (db.status().pendingCount === 0) return;
        void isOnline(true).then((online) => {
          if (online) void syncNow("");
        });
      }, 30_000);
      resolve({ origin: localOrigin, close: () => server.close() });
    });
  });
}

module.exports = { startLocalApp };
