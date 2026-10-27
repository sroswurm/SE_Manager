// Loads config.json fresh on every call so edits (from the web Settings page or by hand)
// take effect for both the MCP server and the web app without a restart.
const fs = require("fs");
const path = require("path");

const APP_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.TNSE_CONFIG || path.join(APP_DIR, "config.json");

function resolvePath(p) {
  if (!p) return p;
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") ? p : path.resolve(APP_DIR, p);
}

function getConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  cfg.workbookPath = resolvePath(process.env.TNSE_WORKBOOK || cfg.workbook);
  cfg.projectsRoot = resolvePath(process.env.TNSE_PROJECTS_ROOT || cfg.projects_root);
  cfg.documentsRoot = resolvePath(process.env.TNSE_DOCUMENTS_ROOT || cfg.documents_root || "./data/Documents");
  return cfg;
}

// Shallow-merge top-level sections; arrays are replaced wholesale.
function updateConfig(patch) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && raw[k] && typeof raw[k] === "object" && !Array.isArray(raw[k])) {
      raw[k] = { ...raw[k], ...v };
    } else {
      raw[k] = v;
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
  return getConfig();
}

module.exports = { getConfig, updateConfig, APP_DIR };
