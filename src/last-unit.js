/**
 * Decides which queued sales can be sent.
 * Keep this in step with biva-dev-app/lib/offline/last-unit.ts.
 */
const LAST_UNIT_MESSAGE = "Another device already sold the last unit. This sale stays on this device.";

function bookKey(warehouseId, id) {
  return `${warehouseId}:${id}`;
}

function pathOnly(path) {
  return String(path || "").split("?")[0];
}

function apiPath(path, name) {
  return new RegExp(`/api/(?:proxy/api/)?${name}$`, "i").test(pathOnly(path));
}

function readJson(body) {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function text(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberFrom(row, keys) {
  for (const key of keys) {
    const value = row[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function listFrom(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const key of ["data", "items", "value"]) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [];
}

function movesFromChange(change) {
  if (String(change.method || "GET").toUpperCase() !== "POST") return [];
  const body = readJson(change.body);
  const path = pathOnly(change.path);
  if (apiPath(path, "stock-records") && body) {
    const delta = numberFrom(body, ["quantity_delta", "quantityDelta", "QuantityDelta"]);
    const warehouseId = text(body, ["warehouse_id", "warehouseId", "WarehouseId"]);
    const id = text(body, ["product_id", "productId", "ProductId"]);
    if (delta == null || delta >= 0 || !warehouseId || !id) return [];
    return [{ kind: "product", warehouseId, id, delta }];
  }
  const withdraw = path.match(/\/sub-categories\/by-tenant\/[^/]+\/([^/]+)\/stock\/withdraw$/i);
  if (withdraw && body) {
    const quantity = numberFrom(body, ["quantity", "Quantity"]);
    const warehouseId = text(body, ["warehouse_id", "warehouseId", "WarehouseId"]);
    const id = decodeURIComponent(withdraw[1] || "");
    if (quantity == null || quantity <= 0 || !warehouseId || !id) return [];
    return [{ kind: "item", warehouseId, id, delta: -Math.floor(quantity) }];
  }
  return [];
}

function isSaleStart(change) {
  return String(change.method || "").toUpperCase() === "POST" && apiPath(change.path, "sales");
}

function isSaleFollowUp(change) {
  if (String(change.method || "").toUpperCase() !== "POST") return false;
  if (apiPath(change.path, "sale-lines") || apiPath(change.path, "receipts")) return true;
  return movesFromChange(change).some((move) => move.delta < 0);
}

function level(books, move) {
  const book = move.kind === "product" ? books.product : books.item;
  if (!book) return null;
  return book.get(bookKey(move.warehouseId, move.id)) ?? 0;
}

function cloneBooks(books) {
  return {
    product: books.product ? new Map(books.product) : null,
    item: books.item ? new Map(books.item) : null,
  };
}

function applyMove(books, move) {
  const book = move.kind === "product" ? books.product : books.item;
  if (!book) return;
  const key = bookKey(move.warehouseId, move.id);
  book.set(key, (book.get(key) ?? 0) + move.delta);
}

function oversellMessage(books, moves) {
  const trial = cloneBooks(books);
  let short = false;
  let left = 0;
  for (const move of moves) {
    const current = level(trial, move);
    if (current == null) continue;
    const next = current + move.delta;
    if (next < 0) {
      short = true;
      left = Math.max(0, current);
      break;
    }
    applyMove(trial, move);
  }
  if (!short) return null;
  if (left <= 0) return LAST_UNIT_MESSAGE;
  return `Only ${left} left. This sale stays on this device.`;
}

function planOfflineSync(pending, books) {
  const ordered = pending
    .map((change, index) => ({ change, index }))
    .sort((left, right) => String(left.change.createdAt || "").localeCompare(String(right.change.createdAt || "")) || left.index - right.index)
    .map((entry) => entry.change);
  const next = cloneBooks(books);
  const send = [];
  const hold = [];
  const take = (group) => {
    const moves = group.flatMap((change) => movesFromChange(change));
    const message = oversellMessage(next, moves);
    if (message) {
      for (const change of group) hold.push({ change, message });
      return;
    }
    for (const move of moves) applyMove(next, move);
    send.push(...group);
  };
  let index = 0;
  while (index < ordered.length) {
    const change = ordered[index];
    if (!isSaleStart(change)) {
      take([change]);
      index += 1;
      continue;
    }
    const group = [change];
    index += 1;
    while (index < ordered.length && isSaleFollowUp(ordered[index])) {
      group.push(ordered[index]);
      index += 1;
    }
    take(group);
  }
  return { send, hold, books: next };
}

function productBookFromRecords(json) {
  const book = new Map();
  for (const row of listFrom(json)) {
    if (!row || typeof row !== "object") continue;
    const warehouseId = text(row, ["warehouse_id", "warehouseId", "WarehouseId"]);
    const id = text(row, ["product_id", "productId", "ProductId"]);
    const qty = numberFrom(row, ["quantity_after", "quantityAfter", "QuantityAfter", "quantity", "Quantity"]);
    if (!warehouseId || !id || qty == null) continue;
    const at = Date.parse(text(row, ["recorded_at", "recordedAt", "RecordedAt"])) || 0;
    const key = bookKey(warehouseId, id);
    const existing = book.get(key);
    if (!existing || at >= existing.at) book.set(key, { qty: Math.max(0, Math.floor(qty)), at });
  }
  return new Map([...book.entries()].map(([key, entry]) => [key, entry.qty]));
}

function itemBookFromStocks(json) {
  const book = new Map();
  for (const row of listFrom(json)) {
    if (!row || typeof row !== "object") continue;
    const warehouseId = text(row, ["warehouse_id", "warehouseId", "WarehouseId"]);
    const id = text(row, ["sub_category_id", "subCategoryId", "SubCategoryId"]);
    const quantity = numberFrom(row, ["quantity", "Quantity"]);
    if (!warehouseId || !id || quantity == null) continue;
    const key = bookKey(warehouseId, id);
    book.set(key, (book.get(key) ?? 0) + Math.max(0, Math.floor(quantity)));
  }
  return book;
}

module.exports = {
  LAST_UNIT_MESSAGE,
  planOfflineSync,
  productBookFromRecords,
  itemBookFromStocks,
  movesFromChange,
};
