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
    add("rsc-auth");
    add("rsc-anon");
    add("prefetch-auth");
    add("prefetch-anon");
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
  return Boolean(tenantIdFromCookie(req.headers.cookie));
}

const WARM_VERSION = "tenant-pages-2";

const TENANT_LISTS = [
  "products", "customers", "suppliers", "categories", "sub-categories", "warehouses", "sales", "sale-lines",
  "receipts", "employees", "departments", "expenses", "incomes", "pos-registers", "cashiers", "shifts",
  "holidays", "leaves", "users", "documents", "document-folders", "job-roles", "payrolls", "payroll-items",
  "allowances", "deductions", "assign-allowances", "assign-deductions", "assign-shifts", "presents", "absents",
  "employee-holidays", "stock-records", "ledgers", "staff-alerts", "subscriptions", "managers",
  "department-heads", "unit-measures", "product-tags", "company-transfers",
];

function tenantIdFromToken(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    for (const [key, value] of Object.entries(json)) {
      if (typeof value !== "string" || !value.trim()) continue;
      if (key === "tenant_id" || key === "tenantId" || key === "TenantId" || key === "tid" || /tenant/i.test(key)) {
        return value.trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

function tenantIdFromCookie(cookie) {
  const match = String(cookie || "").match(/(?:^|;\s*)inventory_access_token=([^;]+)/);
  if (!match) return null;
  try {
    return tenantIdFromToken(decodeURIComponent(match[1]));
  } catch {
    return tenantIdFromToken(match[1]);
  }
}

function pathTenant(urlPath) {
  const match = String(urlPath || "").match(/\/by-tenant\/([^/?]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function rowTenant(row) {
  if (!row || typeof row !== "object") return null;
  const value = row.tenant_id || row.tenantId || row.TenantId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Keep only this tenant's rows. Lists with no tenant field are stored as-is. */
function tenantSlice(text, tenantId) {
  if (!tenantId) return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  const apply = (list) => list.filter((row) => {
    const owner = rowTenant(row);
    return !owner || owner === tenantId;
  });
  if (Array.isArray(json)) return JSON.stringify(apply(json));
  if (json && Array.isArray(json.data)) return JSON.stringify({ ...json, data: apply(json.data) });
  if (json && Array.isArray(json.items)) return JSON.stringify({ ...json, items: apply(json.items) });
  if (json && Array.isArray(json.value)) return JSON.stringify({ ...json, value: apply(json.value) });
  const owner = rowTenant(json);
  if (owner && owner !== tenantId) return null;
  return text;
}

function tenantDataPaths(tenantId) {
  const id = encodeURIComponent(tenantId);
  const paths = TENANT_LISTS.map((name) => `/api/proxy/api/${name}/by-tenant/${id}`);
  paths.push(
    `/api/proxy/api/sales/by-tenant/${id}/kpis`,
    `/api/proxy/api/sales/by-tenant/${id}/daily`,
    `/api/proxy/api/sales/by-tenant/${id}/monthly`,
    `/api/proxy/api/products/by-tenant/${id}/kpis`,
    `/api/proxy/api/departments/overview/by-tenant/${id}`,
    `/api/proxy/api/ledgers/monthly-summary/by-tenant/${id}`,
    `/api/proxy/api/sub-categories/by-tenant/${id}/generations`,
    `/api/proxy/api/sub-categories/by-tenant/${id}/warehouse-stocks`,
    `/api/proxy/api/warehouses/by-tenant/${id}/stock-records`,
    `/api/proxy/api/categories/by-tenant/${id}/stock-records`,
    `/api/proxy/api/payroll-items/by-tenant/${id}/grouped-by-payroll`,
    `/api/proxy/api/staff-attendance/settings/by-tenant/${id}`,
    `/api/proxy/api/nassit/settings/by-tenant/${id}`,
    `/api/proxy/api/paye/settings/by-tenant/${id}`,
    `/api/proxy/api/notifications/by-tenant/${id}/policy`,
  );
  return paths;
}

function applyOfflineChange(db, method, urlPath, bodyText) {
  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = null;
  }
  const match = String(urlPath).split("?")[0].match(/\/api\/(?:proxy\/api\/)?([a-z0-9-]+)(?:\/([^/?]+))?/i);
  const name = match && match[1];
  if (!name || name === "auth" || name === "login" || name === "proxy") return;
  const pathId = match[2] && match[2] !== "by-tenant" ? decodeURIComponent(match[2]) : null;
  const id = (payload && (payload.id || payload.Id)) || pathId || null;
  for (const key of db.listCacheKeys()) {
    if (!String(key).includes(`/api/${name}`) && !String(key).includes(`/api/proxy/api/${name}`)) continue;
    const row = db.read(key);
    if (!row) continue;
    let json;
    try {
      json = JSON.parse(row.body);
    } catch {
      continue;
    }
    const patchList = (list) => {
      if (method === "DELETE" && id) return list.filter((row) => (row && (row.id || row.Id)) !== id);
      if ((method === "PUT" || method === "PATCH") && id && payload) {
        return list.map((row) => ((row && (row.id || row.Id)) === id ? { ...row, ...payload, id } : row));
      }
      if (method === "POST" && payload) return [payload, ...list];
      return list;
    };
    let next = null;
    if (Array.isArray(json)) next = patchList(json);
    else if (json && Array.isArray(json.data)) next = { ...json, data: patchList(json.data) };
    else if (json && Array.isArray(json.items)) next = { ...json, items: patchList(json.items) };
    else if (json && Array.isArray(json.value)) next = { ...json, value: patchList(json.value) };
    if (next) db.writeCache(key, row.status || 200, JSON.stringify(next));
  }
}

function savedStartPath(db) {
  const raw = db.getMeta("session");
  const saved = db.getMeta("sessionPath") || "";
  if (!raw || raw === "null") return null;
  if (!saved.startsWith("/") || saved.startsWith("//") || saved.includes("://")) return null;
  return saved;
}

function pageLinks(html) {
  const found = [];
  for (const match of String(html).matchAll(/href="(\/[^"#]*)"/g)) {
    const path = match[1].split("?")[0];
    if (!path || path.startsWith("/_next") || path.startsWith("/api") || path.startsWith("/__biva")) continue;
    if (/\.[a-z0-9]+$/i.test(path)) continue;
    const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    found.push(clean || "/");
  }
  return found;
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

    function storeGet(urlPath, variant, authed, response, body, tenantId) {
      const type = response.headers.get("content-type") || "application/octet-stream";
      const rewritten = rewriteBody(body, type, origin, localOrigin);
      const folder = urlPath.startsWith("/_next/") ? "asset-anon" : `${variant}-${authed ? "auth" : "anon"}`;
      const apiPath = urlPath.split("?")[0];
      const isApi = apiPath.startsWith("/api/") && type.includes("json");
      let stored = rewritten;
      if (isApi) {
        const owner = pathTenant(apiPath);
        if (owner && tenantId && owner !== tenantId) return rewritten;
        const sliced = tenantSlice(rewritten.toString("utf8"), tenantId);
        if (sliced == null) return rewritten;
        stored = Buffer.from(sliced);
        if (response.ok && db) db.writeCache(`GET ${apiPath}`, response.status, sliced);
      }
      if (response.ok) writeMirror(safeFile(mirror, urlPath, folder), stored, { status: response.status, contentType: type });
      return rewritten;
    }

    function forgetOtherTenants(tenantId) {
      if (!db.dropCache) return;
      for (const key of db.listCacheKeys()) {
        const path = String(key).replace(/^GET\s+/, "");
        if (!path.startsWith("/api/")) continue;
        const owner = pathTenant(path);
        if (!owner || (tenantId && owner !== tenantId)) db.dropCache(key);
      }
    }

    async function warm(cookie) {
      if (warming || !db) return;
      const tenantId = tenantIdFromCookie(cookie);
      if (!tenantId) return;
      if (db.getMeta("warmVersion") === WARM_VERSION && db.getMeta("tenantId") === tenantId) return;
      warming = true;
      db.setMeta("uiReady", "running");
      db.setMeta("tenantId", tenantId);
      const headers = { accept: "text/html,application/xhtml+xml", cookie: cookie || "" };
      try {
        forgetOtherTenants(tenantId);
        let savedLists = 0;
        for (const path of tenantDataPaths(tenantId)) {
          if (!(await isOnline())) break;
          try {
            const list = await pull(path, { accept: "application/json", cookie: cookie || "" });
            if (list.response.ok) {
              storeGet(path, "document", true, list.response, list.body, tenantId);
              savedLists += 1;
            }
          } catch {
            // This list is not available for every account.
          }
        }
        if (savedLists > 0) db.setMeta("seeded", new Date().toISOString());

        const queue = [...routes];
        const seen = new Set(queue);
        let finished = true;
        for (let index = 0; index < queue.length && index < 500; index += 1) {
          if (!(await isOnline())) {
            finished = false;
            break;
          }
          const route = queue[index];
          try {
            const document = await pull(route, headers);
            const body = storeGet(route, "document", true, document.response, document.body, tenantId);
            const html = body.toString("utf8");
            for (const link of pageLinks(html)) {
              if (!seen.has(link)) {
                seen.add(link);
                queue.push(link);
              }
            }
            const assets = new Set();
            for (const match of html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)) assets.add(match[1].split("?")[0]);
            for (const asset of assets) {
              const saved = await pull(asset, { accept: "*/*" });
              storeGet(asset, "asset", false, saved.response, saved.body, tenantId);
            }
            const flight = await pull(route, { ...headers, rsc: "1", accept: "*/*" });
            storeGet(route, "rsc", true, flight.response, flight.body, tenantId);
          } catch {
            // Keep saving the other screens.
          }
        }
        if (finished && (await isOnline())) {
          db.setMeta("warmVersion", WARM_VERSION);
          db.setMeta("uiReady", new Date().toISOString());
        } else if (db.getMeta("uiReady") === "running") db.setMeta("uiReady", "");
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
          if (stored.authorization && !headers.cookie) headers.authorization = stored.authorization;
          if (stored.cookie && !headers.cookie) headers.cookie = stored.cookie;
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
            if (saved.response.ok) storeGet(String(key).slice(4), "document", true, saved.response, saved.body, tenantIdFromCookie(cookie));
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
        const sessionTenant = tenantIdFromCookie(req.headers.cookie);
        if (sessionTenant && (db.getMeta("warmVersion") !== WARM_VERSION || db.getMeta("tenantId") !== sessionTenant)) {
          void warm(String(req.headers.cookie || ""));
        }
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
        if (urlPath.startsWith("/__biva/session") && req.method === "GET") {
          const raw = db.getMeta("session");
          const path = db.getMeta("sessionPath");
          let session = null;
          try {
            session = raw ? JSON.parse(raw) : null;
          } catch {
            session = null;
          }
          send(res, 200, JSON.stringify(session ? { session, path } : null), { "content-type": "application/json" });
          return;
        }
        if (urlPath.startsWith("/__biva/session") && req.method === "DELETE") {
          db.setMeta("session", "");
          db.setMeta("sessionToken", "");
          db.setMeta("sessionPath", "");
          send(res, 204, "", { "content-type": "application/json" });
          return;
        }
        if (urlPath.startsWith("/__biva/session") && req.method === "POST") {
          const posted = JSON.parse((await readRequestBody(req)).toString("utf8") || "{}");
          if (posted.session) {
            db.setMeta("session", JSON.stringify(posted.session));
            if (posted.session.token) db.setMeta("sessionToken", posted.session.token);
          }
          if (typeof posted.path === "string" && posted.path.startsWith("/")) db.setMeta("sessionPath", posted.path);
          send(res, 204, "", { "content-type": "application/json" });
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
            if (!multipart) applyOfflineChange(db, method, urlPath, body.toString("utf8"));
            let echoed = { id, offlineQueued: true };
            if (!multipart) {
              try {
                const parsed = JSON.parse(body.toString("utf8"));
                if (parsed && typeof parsed === "object") echoed = { ...parsed, id, offlineQueued: true };
              } catch {
                // The queue entry is enough when the body is not JSON.
              }
            }
            send(res, 202, JSON.stringify(echoed), { "content-type": "application/json" });
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
            if (response.status === 401) {
              const saved = findSaved(mirror, urlPath, variant, authed);
              const row = !saved && urlPath.startsWith("/api/") ? db.read(`GET ${urlPath.split("?")[0]}`) : null;
              const body = saved?.body || row?.body;
              if (body) {
                send(res, saved?.meta?.status || row?.status || 200, body, {
                  "content-type": saved?.meta?.contentType || "application/json",
                });
                return;
              }
            }
            const body = storeGet(urlPath, urlPath.startsWith("/_next/") ? "asset" : variant, urlPath.startsWith("/_next/") ? false : authed, response, raw, sessionTenant);
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

module.exports = { startLocalApp, savedStartPath };
