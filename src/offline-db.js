/**
 * SQLite file on this computer. The website asks for it through the preload bridge.
 * First launch copies the business down from the API. Later launches can read it with no internet.
 */
const fs = require("node:fs");
const path = require("node:path");

function wasmFile() {
  const name = "sql-wasm.wasm";
  const unpacked = path.join(
    process.resourcesPath || "",
    "app.asar.unpacked",
    "node_modules",
    "sql.js",
    "dist",
    name,
  );
  if (process.resourcesPath && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, "..", "node_modules", "sql.js", "dist", name);
}

function openOfflineDb(file) {
  const initSqlJs = require("sql.js");
  return initSqlJs({ locateFile: () => wasmFile() }).then((SQL) => {
    const existing = fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null;
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content_type TEXT,
        encoding TEXT,
        headers TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    for (const column of ["content_type TEXT", "encoding TEXT", "headers TEXT"]) {
      try {
        db.run(`ALTER TABLE outbox ADD COLUMN ${column}`);
      } catch {
        // The column is already there.
      }
    }

    function persist() {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, Buffer.from(db.export()));
    }

    function meta(key) {
      const stmt = db.prepare("SELECT value FROM meta WHERE key = ?");
      stmt.bind([key]);
      const value = stmt.step() ? stmt.getAsObject().value : null;
      stmt.free();
      return value ?? null;
    }

    function setMeta(key, value) {
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, String(value)]);
      persist();
    }

    function status() {
      const pending = [];
      const stmt = db.prepare(
        "SELECT id, method, path, body, summary, created_at AS createdAt, content_type AS contentType, encoding, headers FROM outbox ORDER BY created_at ASC",
      );
      while (stmt.step()) pending.push(stmt.getAsObject());
      stmt.free();
      return {
        seeded: Boolean(meta("seeded")),
        lastSyncAt: meta("lastSyncAt"),
        pendingCount: pending.length,
        pending,
      };
    }

    function read(key) {
      const stmt = db.prepare("SELECT status, body, updated_at AS updatedAt FROM cache WHERE key = ?");
      stmt.bind([key]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row;
    }

    function writeCache(key, statusCode, body) {
      db.run("INSERT OR REPLACE INTO cache (key, status, body, updated_at) VALUES (?, ?, ?, ?)", [
        key,
        statusCode,
        body,
        new Date().toISOString(),
      ]);
      persist();
      return true;
    }

    function enqueue(entry) {
      db.run(
        `INSERT OR REPLACE INTO outbox
          (id, method, path, body, summary, created_at, content_type, encoding, headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.method,
          entry.path,
          entry.body ?? null,
          entry.summary,
          entry.createdAt,
          entry.contentType ?? null,
          entry.encoding ?? "utf8",
          entry.headers ?? null,
        ],
      );
      persist();
      return status();
    }

    function dropCache(key) {
      db.run("DELETE FROM cache WHERE key = ?", [key]);
      persist();
    }

    function listCacheKeys() {
      const keys = [];
      const stmt = db.prepare("SELECT key FROM cache");
      while (stmt.step()) keys.push(stmt.getAsObject().key);
      stmt.free();
      return keys;
    }

    function drop(id) {
      db.run("DELETE FROM outbox WHERE id = ?", [id]);
      persist();
      return status();
    }

    function markSynced() {
      setMeta("lastSyncAt", new Date().toISOString());
      return status();
    }

    persist();
    return { status, read, writeCache, dropCache, enqueue, drop, setMeta, getMeta: meta, listCacheKeys, markSynced };
  });
}

function registerOfflineIpc(ipcMain, dbPromise) {
  async function db() {
    return dbPromise;
  }
  ipcMain.handle("biva-offline:status", async () => (await db()).status());
  ipcMain.handle("biva-offline:read", async (_event, key) => (await db()).read(key));
  ipcMain.handle("biva-offline:write-cache", async (_event, key, statusCode, body) =>
    (await db()).writeCache(key, statusCode, body),
  );
  ipcMain.handle("biva-offline:enqueue", async (_event, entry) => (await db()).enqueue(entry));
  ipcMain.handle("biva-offline:drop", async (_event, id) => (await db()).drop(id));
  ipcMain.handle("biva-offline:set-meta", async (_event, key, value) => {
    (await db()).setMeta(key, value);
    return (await db()).status();
  });
  ipcMain.handle("biva-offline:mark-synced", async () => (await db()).markSynced());
}

module.exports = { openOfflineDb, registerOfflineIpc };
