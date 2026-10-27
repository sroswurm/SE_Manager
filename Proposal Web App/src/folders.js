// Project folder generation on the local / network drive.
const fs = require("fs");
const path = require("path");

const safeName = (s) => String(s || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim();

function projectFolderName(projectNo, name) {
  return `${projectNo} - ${safeName(name)}`.slice(0, 120);
}

// Highest YYNNN number already on disk for this year (so numbering stays in step with
// folders created before this tool existed).
function maxFolderNumber(root, yy) {
  if (!root || !fs.existsSync(root)) return 0;
  let max = 0;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const m = d.name.match(/^(\d{2})(\d{3})\b/);
    if (m && m[1] === yy) max = Math.max(max, Number(m[2]));
  }
  return max;
}

// selection: array of top-level folder names; null → template defaults.
// extra: optional array of additional folder paths (e.g. "04_Design/Wind").
function generateFolders({ cfg, projectNo, name, selection, extra = [] }) {
  const root = cfg.projectsRoot;
  if (!root) throw new Error("projects_root is not set in config.json");
  if (!fs.existsSync(root)) throw new Error(`Projects root not found: ${root}. Check projects_root in config.json (the drive may not be mapped).`);
  const base = path.join(root, projectFolderName(projectNo, name));
  const picked = cfg.folder_templates.filter((t) => (selection ? selection.includes(t.name) : t.default));
  const created = [], existed = [];
  const mk = (p) => {
    if (fs.existsSync(p)) existed.push(p);
    else { fs.mkdirSync(p, { recursive: true }); created.push(p); }
  };
  mk(base);
  for (const t of picked) {
    mk(path.join(base, safeName(t.name)));
    for (const c of t.children || []) mk(path.join(base, safeName(t.name), safeName(c)));
  }
  for (const e of extra) mk(path.join(base, ...String(e).split(/[\\/]/).map(safeName).filter(Boolean)));

  const copied = [];
  for (const s of cfg.seed_files || []) {
    if (!s.from || !fs.existsSync(s.from)) continue;
    const destDir = path.join(base, s.to || "");
    if (!fs.existsSync(destDir)) continue; // only seed into folders that were selected
    const dest = path.join(destDir, path.basename(s.from).replace(/^TEMPLATE/i, projectNo));
    if (!fs.existsSync(dest)) { fs.copyFileSync(s.from, dest); copied.push(dest); }
  }
  return { base, folders: picked.map((t) => t.name), created: created.length, existed: existed.length, copied };
}

module.exports = { generateFolders, maxFolderNumber, projectFolderName, safeName };
