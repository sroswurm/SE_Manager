// Excel-workbook data store.
// Every operation loads the workbook fresh, runs in memory, and writes back atomically,
// guarded by a lock file so the MCP server and the web app can run side by side.
// Columns you add by hand in Excel are preserved.
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { getConfig } = require("./config");

const SCHEMA = {
  Leads: ["lead_id", "received", "source", "contact_name", "company", "phone", "email",
    "project_name", "location", "state", "description", "raw_message", "response_due",
    "status", "decision", "decision_reason", "bid_score", "client_id", "project_no", "updated"],
  Clients: ["client_id", "company", "contact_name", "title", "phone", "email", "address",
    "city", "state", "zip", "billing_contact", "billing_email", "client_type", "notes", "created"],
  Projects: ["project_no", "lead_id", "client_id", "name", "address", "city", "state",
    "project_type", "sf", "construction_value", "expedite", "start_date", "status",
    "folder_path", "description", "assumptions", "exclusions",
    "fee_design", "fee_addons", "fee_total", "fee_detail",
    "proposal_rev", "proposal_date", "proposal_path", "created", "updated"],
  Scope: ["project_no", "line", "type", "description", "pool", "basis", "rate_key",
    "hours", "rate", "qty", "unit", "unit_fee", "fee"],
  Milestones: ["project_no", "milestone", "target_date", "billing_pct", "billing_amount", "note"],
  FeeHistory: ["project_no", "name", "project_type", "state", "sf", "construction_value",
    "fee", "hours", "year", "source", "notes"],
  Log: ["timestamp", "ref", "action", "detail"],
};

const NUMERIC = new Set(["sf", "construction_value", "fee_design", "fee_addons", "fee_total",
  "hours", "rate", "qty", "unit_fee", "fee", "milestone", "billing_pct", "billing_amount",
  "line", "year", "bid_score", "proposal_rev"]);

class StoreBusyError extends Error {}

// Synchronous sleep without busy-spinning the CPU.
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function acquireLock(lockPath, timeoutMs = 10000) {
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 30000) { fs.unlinkSync(lockPath); continue; } // stale lock
      } catch { /* lock vanished between calls */ }
      if (Date.now() - start > timeoutMs) throw new StoreBusyError("Workbook is locked by another operation; try again.");
      sleep(100);
    }
  }
}

function cellValue(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result);          // formula
    if ("text" in v) return v.text;                          // hyperlink
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  }
  return v;
}

async function readTables(file) {
  const tables = {};
  const headers = {};
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(file)) await wb.xlsx.readFile(file);
  for (const name of Object.keys(SCHEMA)) {
    const ws = wb.getWorksheet(name);
    const rows = [];
    let hdr = [...SCHEMA[name]];
    if (ws && ws.rowCount > 0) {
      const found = [];
      ws.getRow(1).eachCell({ includeEmpty: false }, (c, col) => { found[col - 1] = String(cellValue(c.value)).trim(); });
      if (found.length) hdr = [...found.filter(Boolean), ...SCHEMA[name].filter((h) => !found.includes(h))];
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const obj = {};
        let any = false;
        found.forEach((h, i) => {
          if (!h) return;
          const v = cellValue(row.getCell(i + 1).value);
          if (v !== "") any = true;
          obj[h] = NUMERIC.has(h) && v !== "" && !isNaN(Number(v)) ? Number(v) : v;
        });
        if (any) rows.push(obj);
      }
    }
    tables[name] = rows;
    headers[name] = hdr;
  }
  return { tables, headers };
}

async function writeTables(file, tables, headers) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TNSE Project Manager";
  for (const name of Object.keys(SCHEMA)) {
    const hdr = headers[name];
    for (const row of tables[name]) for (const k of Object.keys(row)) if (!hdr.includes(k)) hdr.push(k);
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = hdr.map((h) => ({ header: h, key: h, width: Math.min(Math.max(h.length + 4, 12), 48) }));
    for (const row of tables[name]) ws.addRow(Object.fromEntries(hdr.map((h) => [h, row[h] ?? ""])));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: hdr.length } };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await wb.xlsx.writeFile(tmp);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (["EBUSY", "EPERM", "EACCES"].includes(e.code)) {
      throw new StoreBusyError(`Can't save ${path.basename(file)} — it is probably open in Excel. Close it and retry.`);
    }
    throw e;
  }
}

// Run fn(db) against a fresh in-memory copy; if fn returns without throwing and write=true,
// the workbook is saved. db.tables.<Sheet> are plain arrays of row objects.
async function withStore(fn, { write = true } = {}) {
  const file = getConfig().workbookPath;
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (write) acquireLock(lock);
  try {
    const { tables, headers } = await readTables(file);
    const db = {
      tables,
      log(ref, action, detail = "") {
        tables.Log.push({ timestamp: new Date().toISOString().replace("T", " ").slice(0, 19), ref, action, detail: String(detail).slice(0, 500) });
      },
    };
    const result = await fn(db);
    if (write) await writeTables(file, tables, headers);
    return result;
  } finally {
    if (write) try { fs.unlinkSync(lock); } catch {}
  }
}

const read = (fn) => withStore(fn, { write: false });

module.exports = { withStore, read, SCHEMA, StoreBusyError };
