import { readFile, writeFile, rename, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const TABLE_FILES = [
    "clients.json",
    "projects.json",
    "deliverables.json",
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
export async function ensureDataDir() {
    await mkdir(DATA_DIR, { recursive: true });
    for (const file of TABLE_FILES) {
        const filepath = join(DATA_DIR, file);
        if (!(await fileExists(filepath))) {
            await writeFile(filepath, "[]", "utf-8");
        }
    }
}
export async function readTable(table) {
    const filepath = join(DATA_DIR, table);
    const raw = await readFile(filepath, "utf-8");
    return JSON.parse(raw);
}
export async function writeTable(table, data) {
    await withLock(async () => {
        const filepath = join(DATA_DIR, table);
        const tempPath = filepath + ".tmp";
        await writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
        await rename(tempPath, filepath);
    });
}
export async function findById(table, id) {
    const rows = await readTable(table);
    return rows.find((r) => r.id === id);
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
