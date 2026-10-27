// Client documents per project (drawings, specs, RFPs…). Dropped in the web app, read by
// Claude through the MCP server (read_document) to draft the scope.
const fs = require("fs");
const path = require("path");

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".eml", ".json", ".xml", ".html", ".htm"]);
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_TEXT = 60000; // characters per read_document call; longer files are read in chunks
const MAX_IMAGE = 5 * 1024 * 1024;

const ext = (name) => path.extname(name).toLowerCase();
const cleanNo = (no) => {
  const s = String(no || "");
  if (!/^[\w-]+$/.test(s)) throw new Error(`Bad project number: ${no}`);
  return s;
};
const cleanName = (name) => {
  const s = path.basename(String(name || "")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim();
  if (!s || s.startsWith(".")) throw new Error(`Bad file name: ${name}`);
  return s;
};

const docsDir = (cfg, projectNo) => path.join(cfg.documentsRoot, cleanNo(projectNo));

function readableAs(name) {
  const e = ext(name);
  if (e === ".pdf") return "pdf";
  if (e === ".docx") return "word";
  if (e === ".xlsx") return "spreadsheet";
  if (IMAGE_MIME[e]) return "image";
  if (TEXT_EXT.has(e)) return "text";
  return null;
}

function listDocs(cfg, projectNo) {
  const dir = docsDir(cfg, projectNo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => {
    const st = fs.statSync(path.join(dir, d.name));
    return { name: d.name, size: st.size, added: st.mtime.toISOString().slice(0, 16).replace("T", " "), readable_as: readableAs(d.name) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function docPath(cfg, projectNo, name) {
  const p = path.join(docsDir(cfg, projectNo), cleanName(name));
  if (!fs.existsSync(p)) throw new Error(`No document "${name}" for project ${projectNo}`);
  return p;
}

function saveDoc(cfg, projectNo, name, buf) {
  const dir = docsDir(cfg, projectNo);
  fs.mkdirSync(dir, { recursive: true });
  const file = cleanName(name);
  fs.writeFileSync(path.join(dir, file), buf);
  return file;
}

function deleteDoc(cfg, projectNo, name) { fs.unlinkSync(docPath(cfg, projectNo, name)); }

async function pdfText(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // verbosity 0: pdfjs warnings go to stdout, which would corrupt the MCP stdio stream
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { items } = await (await doc.getPage(i)).getTextContent();
    const s = items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ").trim();
    pages.push(`--- Page ${i} ---\n${s}`);
  }
  await doc.destroy();
  return pages.join("\n\n");
}

async function docxText(file) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = (await zip.file("word/document.xml")?.async("string")) || "";
  return xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function xlsxText(file) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow((r) => { const cells = []; r.eachCell({ includeEmpty: true }, (c) => cells.push(c.text)); rows.push(cells.join("\t")); });
    return `--- Sheet ${ws.name} ---\n${rows.join("\n")}`;
  }).join("\n\n");
}

// MCP content blocks for one document: its text (in chunks of MAX_TEXT from `start`), or the image itself.
async function readDoc(cfg, projectNo, name, { start = 0 } = {}) {
  const file = docPath(cfg, projectNo, name), kind = readableAs(name);
  if (kind === "image") {
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_IMAGE) return [{ type: "text", text: `${name}: image is ${(buf.length / 1048576).toFixed(1)} MB — too large to read (limit 5 MB). Ask the user for a smaller export.` }];
    return [{ type: "text", text: `${name} (image)` }, { type: "image", data: buf.toString("base64"), mimeType: IMAGE_MIME[ext(name)] }];
  }
  const reader = { pdf: pdfText, word: docxText, spreadsheet: xlsxText, text: (f) => fs.readFileSync(f, "utf8") }[kind];
  if (!reader) throw new Error(`Can't read ${ext(name) || "this kind of"} file — ask the user for a PDF, Word (.docx), Excel (.xlsx), text or image version.`);
  const text = await reader(file);
  if (!text.replace(/--- (Page|Sheet) .* ---/g, "").trim()) {
    return [{ type: "text", text: `${name}: no text found (likely a scanned PDF or drawings without a text layer). Ask the user to upload the key sheets as images, or to tell you the essentials.` }];
  }
  const chunk = text.slice(start, start + MAX_TEXT), end = start + chunk.length;
  const more = end < text.length ? `\n\n[${text.length - end} more characters — call read_document again with start=${end}]` : "";
  return [{ type: "text", text: `${name} — characters ${start}–${end} of ${text.length}\n\n${chunk}${more}` }];
}

module.exports = { listDocs, saveDoc, deleteDoc, docPath, readDoc };
