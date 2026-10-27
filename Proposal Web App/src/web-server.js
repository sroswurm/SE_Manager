#!/usr/bin/env node
// TNSE Project Manager — local web app. Same actions as the MCP server, plus PDF preview/download.
const fs = require("fs");
const path = require("path");
const express = require("express");
const { run, actions } = require("./lifecycle");
const { read } = require("./store");
const { getConfig } = require("./config");
const { estimateFee } = require("./fee");
const { buildProposalPdf } = require("./proposal");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/actions", (_req, res) => res.json(Object.fromEntries(Object.entries(actions).map(([k, a]) => [k, a.description]))));

app.post("/api/action/:name", async (req, res) => {
  try {
    res.json(await run(req.params.name, req.body));
  } catch (e) {
    const msg = e.issues ? e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : e.message;
    res.status(400).json({ error: msg });
  }
});

const lines = (v) => String(v || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

// Unsaved preview of the proposal (does not bump the revision or write a file).
app.get("/api/preview/:no", async (req, res) => {
  try {
    const cfg = getConfig();
    const buf = await read(async (db) => {
      const p = db.tables.Projects.find((x) => String(x.project_no) === req.params.no);
      if (!p) throw new Error("Project not found");
      const client = db.tables.Clients.find((c) => c.client_id === p.client_id) || {};
      const lead = db.tables.Leads.find((l) => l.lead_id === p.lead_id) || {};
      let opts = {}; try { opts = JSON.parse(p.fee_detail || "{}").options || {}; } catch {}
      const scope = db.tables.Scope.filter((s) => String(s.project_no) === String(p.project_no));
      const fee = estimateFee({ project: p, lines: scope, history: db.tables.FeeHistory, cfg, options: opts });
      const ms = db.tables.Milestones.filter((m) => String(m.project_no) === String(p.project_no)).sort((a, b) => a.milestone - b.milestone);
      const rev = Number(p.proposal_rev || 0) + (p.proposal_path ? 1 : 0);
      return buildProposalPdf({ cfg, project: { ...p, assumptions: lines(p.assumptions), exclusions: lines(p.exclusions) }, client, lead, fee, milestones: ms, rev, date: new Date().toLocaleDateString("en-CA") });
    });
    res.type("application/pdf").set("Content-Disposition", `inline; filename="${req.params.no} preview.pdf"`).send(buf);
  } catch (e) { res.status(400).send(e.message); }
});

// The last saved proposal PDF for a project.
app.get("/api/proposal/:no", async (req, res) => {
  try {
    const p = await read((db) => db.tables.Projects.find((x) => String(x.project_no) === req.params.no));
    if (!p || !p.proposal_path || !fs.existsSync(p.proposal_path)) return res.status(404).send("No saved proposal yet");
    res.type("application/pdf").set("Content-Disposition", `inline; filename="${path.basename(p.proposal_path)}"`);
    fs.createReadStream(p.proposal_path).pipe(res);
  } catch (e) { res.status(400).send(e.message); }
});

const cfg = getConfig();
const port = Number(process.env.PORT || cfg.web_port || 4180);
const host = process.env.HOST || cfg.web_host || "127.0.0.1"; // local only unless you choose otherwise
app.listen(port, host, () => {
  console.log(`TNSE Project Manager → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`Workbook: ${cfg.workbookPath}`);
  console.log(`Projects root: ${cfg.projectsRoot}${fs.existsSync(cfg.projectsRoot) ? "" : "  (NOT FOUND — set projects_root in config.json)"}`);
});
