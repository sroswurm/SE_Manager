#!/usr/bin/env node
// Creates the workbook (all sheets, headers) if it doesn't exist, and checks the projects root.
const fs = require("fs");
const { withStore } = require("./store");
const { getConfig } = require("./config");
(async () => {
  const cfg = getConfig();
  const existed = fs.existsSync(cfg.workbookPath);
  await withStore(() => {});
  console.log(`${existed ? "Workbook OK" : "Created workbook"}: ${cfg.workbookPath}`);
  console.log(fs.existsSync(cfg.projectsRoot) ? `Projects root OK: ${cfg.projectsRoot}` : `Projects root NOT FOUND: ${cfg.projectsRoot}\n  → set "projects_root" in config.json (e.g. "P:\\\\Projects")`);
})().catch((e) => { console.error(e.message); process.exit(1); });
