import { readFile, writeFile, rename, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const SCHEMA_VERSION = "0.1.0";
const TABLE_FILES = [
    "clients.json",
    "projects.json",
    "deadlines.json",
];
let writeLock = Promise.resolve();
async function withLock(fn) {
    const prior = writeLock;
    let resolve;
    writeLock = new Promise((r) => { resolve = r; });
    await prior;
    try {
        return await fn();
    }
    finally {
        resolve();
    }
}
async function fileExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
function tableKey(filename) {
    return filename.replace(".json", "");
}
export async function ensureDataDir() {
    await mkdir(DATA_DIR, { recursive: true });
    for (const file of TABLE_FILES) {
        const filepath = join(DATA_DIR, file);
        if (!(await fileExists(filepath))) {
            const key = tableKey(file);
            await writeFile(filepath, JSON.stringify({ schema_version: SCHEMA_VERSION, [key]: [] }, null, 2), "utf-8");
        }
    }
}
export async function readTable(table) {
    const filepath = join(DATA_DIR, table);
    const raw = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
        return parsed;
    const key = tableKey(table);
    return (parsed[key] ?? []);
}
export async function writeTable(table, data) {
    await withLock(async () => {
        const filepath = join(DATA_DIR, table);
        const key = tableKey(table);
        const wrapper = { schema_version: SCHEMA_VERSION, [key]: data };
        const tempPath = filepath + ".tmp";
        await writeFile(tempPath, JSON.stringify(wrapper, null, 2), "utf-8");
        await rename(tempPath, filepath);
    });
}
export async function findById(table, idField, id) {
    const rows = await readTable(table);
    return rows.find((r) => r[idField] === id);
}
export async function findByField(table, field, value) {
    const rows = await readTable(table);
    return rows.filter((r) => r[field] === value);
}
export async function insertRow(table, row) {
    const rows = await readTable(table);
    rows.push(row);
    await writeTable(table, rows);
}
