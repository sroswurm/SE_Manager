import { readFile, writeFile, rename, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TableName, TableMap } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const SCHEMA_VERSION = "0.1.0";

const TABLE_FILES: TableName[] = [
  "clients.json",
  "projects.json",
  "deadlines.json",
];

let writeLock = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  await prior;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tableKey(filename: string): string {
  return filename.replace(".json", "");
}

export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  for (const file of TABLE_FILES) {
    const filepath = join(DATA_DIR, file);
    if (!(await fileExists(filepath))) {
      const key = tableKey(file);
      await writeFile(filepath, JSON.stringify({ schema_version: SCHEMA_VERSION, [key]: [] }, null, 2), "utf-8");
    }
  }
}

export async function readTable<K extends TableName>(table: K): Promise<TableMap[K][]> {
  const filepath = join(DATA_DIR, table);
  const raw = await readFile(filepath, "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as TableMap[K][];
  const key = tableKey(table);
  return (parsed[key] ?? []) as TableMap[K][];
}

export async function writeTable<K extends TableName>(table: K, data: TableMap[K][]): Promise<void> {
  await withLock(async () => {
    const filepath = join(DATA_DIR, table);
    const key = tableKey(table);
    const wrapper = { schema_version: SCHEMA_VERSION, [key]: data };
    const tempPath = filepath + ".tmp";
    await writeFile(tempPath, JSON.stringify(wrapper, null, 2), "utf-8");
    await rename(tempPath, filepath);
  });
}

export async function findById<K extends TableName>(
  table: K,
  idField: string,
  id: string,
): Promise<TableMap[K] | undefined> {
  const rows = await readTable(table);
  return rows.find((r: any) => r[idField] === id);
}

export async function findByField<K extends TableName>(
  table: K,
  field: string,
  value: string,
): Promise<TableMap[K][]> {
  const rows = await readTable(table);
  return rows.filter((r: any) => r[field] === value);
}

export async function insertRow<K extends TableName>(
  table: K,
  row: TableMap[K],
): Promise<void> {
  const rows = await readTable(table);
  rows.push(row);
  await writeTable(table, rows);
}
