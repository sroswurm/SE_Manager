// Project lifecycle actions. Each action has a description, a zod input shape and a handler.
// The MCP server registers these as tools; the web app calls them via POST /api/action/:name.
const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { withStore, read } = require("./store");
const { getConfig, updateConfig, APP_DIR } = require("./config");
const { estimateFee, priceLine } = require("./fee");
const { folderScript, maxFolderNumber, safeName } = require("./folders");
const { listDocs } = require("./documents");
const { buildProposalPdf } = require("./proposal");
const { parseEmail } = require("./parse-email");

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const addDays = (iso, d) => { const t = new Date(`${iso}T12:00:00`); t.setDate(t.getDate() + Math.round(d)); return t.toLocaleDateString("en-CA"); };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9@.]/g, "");
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const lines = (v) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);
const parseJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const LEAD_STATUSES = ["New", "Bid - Preparing Proposal", "No Bid", "Proposal Issued", "Won", "Lost"];
const BID_CRITERIA = {
  existing_client: "Existing or referred client",
  core_expertise: "Within TNSE core expertise",
  capacity: "Staff capacity for the schedule",
  schedule_feasible: "Schedule is achievable",
  fee_adequate: "Fee potential justifies effort",
  risk_acceptable: "Liability / payment risk acceptable",
};

function nextLeadId(leads) {
  const d = today().replace(/-/g, "").slice(2);
  const n = leads.filter((l) => String(l.lead_id).startsWith(`L${d}`)).length + 1;
  return `L${d}-${String(n).padStart(2, "0")}`;
}
function nextClientId(clients) {
  const max = clients.reduce((m, c) => Math.max(m, Number(String(c.client_id).replace(/\D/g, "")) || 0), 0);
  return `C${String(max + 1).padStart(4, "0")}`;
}
function nextProjectNo(projects, cfg) {
  const yy = today().slice(2, 4);
  let max = maxFolderNumber(cfg.projectsRoot, yy);
  for (const p of projects) {
    const m = String(p.project_no).match(/^(\d{2})(\d{3})$/);
    if (m && m[1] === yy) max = Math.max(max, Number(m[2]));
  }
  return `${yy}${String(max + 1).padStart(3, "0")}`;
}

function clientMatches(clients, { email, phone, company, contact_name }) {
  return clients.filter((c) =>
    (email && norm(c.email) === norm(email)) ||
    (phone && digits(phone).length >= 7 && digits(c.phone) === digits(phone)) ||
    (company && norm(company).length > 2 && norm(c.company) === norm(company)) ||
    (contact_name && norm(contact_name).length > 3 && norm(c.contact_name) === norm(contact_name)));
}

function mustFind(rows, key, val, label) {
  const r = rows.find((x) => String(x[key]) === String(val));
  if (!r) throw new Error(`${label} ${val} not found`);
  return r;
}

function feeFor(db, project, cfg) {
  const opts = parseJSON(project.fee_detail, {}).options || {};
  const scope = db.tables.Scope.filter((s) => String(s.project_no) === String(project.project_no)).sort((a, b) => a.line - b.line);
  return estimateFee({ project, lines: scope, history: db.tables.FeeHistory, cfg, options: opts });
}

function milestoneRows(project, cfg, { milestones, start_date, dates = {}, billing_pct = {}, notes = {} }) {
  const ptype = cfg.project_types.find((t) => t.name === project.project_type) || {};
  // Building design gets progress sets; letters, reports and small jobs default to one 100% submittal.
  const typeDefault = ptype.milestones || (ptype.area_methods ? cfg.milestones.default : [100]);
  const sel = [...new Set((milestones && milestones.length ? milestones : typeDefault).map(Number))].sort((a, b) => a - b);
  const exp = cfg.fee_model.expedite[project.expedite || "Standard"] || { schedule_factor: 1 };
  const start = start_date || project.start_date || today();
  let prev = 0;
  return sel.map((m) => {
    const weeks = Number(cfg.milestones.weeks_from_ntp[String(m)] ?? (m / 100) * 8);
    const row = {
      project_no: project.project_no, milestone: m,
      target_date: dates[String(m)] || addDays(start, weeks * 7 * Number(exp.schedule_factor || 1)),
      billing_pct: billing_pct[String(m)] !== undefined ? Number(billing_pct[String(m)]) : m - prev,
      billing_amount: "", note: notes[String(m)] || "",
    };
    prev = m;
    return row;
  });
}

// ─────────────────────────────────────────── actions
const lineSchema = z.object({
  type: z.string().describe("Deliverable type from the catalog (see get_settings → deliverable_types), e.g. 'Structural Drawings', 'Special Inspection'"),
  description: z.string().optional().describe("Scope text that will print on the proposal"),
  hours: z.number().optional().describe("Hours (hourly basis) or hours per unit (each basis); defaults from catalog"),
  qty: z.number().optional().describe("Quantity for per-each items, e.g. number of inspections"),
  unit_fee: z.number().optional().describe("Fixed $ per unit (each) or lump sum; overrides hours × rate"),
  rate_key: z.string().optional().describe("engineering | eit | drafting | admin"),
  basis: z.enum(["hourly", "each", "lump"]).optional(),
  pool: z.enum(["design", "addon"]).optional().describe("design = averaged into the design fee; addon = priced on top"),
});

const actions = {
  intake_rfp: {
    description: "Step 1 — Log an incoming RFP / request (phone call, text, or email). Paste the raw message in raw_message. Returns a lead_id and any existing clients that match the contact.",
    input: {
      source: z.enum(["phone", "text", "email", "web", "referral", "other"]),
      contact_name: z.string().optional(), company: z.string().optional(),
      phone: z.string().optional(), email: z.string().optional(),
      project_name: z.string().describe("Short project name, e.g. '503 N Navy Blvd Generator Platform'"),
      location: z.string().optional().describe("Address or city"), state: z.string().optional().describe("2-letter state"),
      description: z.string().optional(), raw_message: z.string().optional(),
      response_due: z.string().optional().describe("YYYY-MM-DD"), received: z.string().optional(),
    },
    async handler(a) {
      return withStore((db) => {
        const lead = { ...a, lead_id: nextLeadId(db.tables.Leads), received: a.received || today(), status: "New", state: (a.state || "").toUpperCase(), updated: stamp() };
        db.tables.Leads.push(lead);
        db.log(lead.lead_id, "intake_rfp", `${a.source}: ${a.project_name}`);
        const cfg = getConfig();
        const flags = [];
        if (lead.state && !cfg.firm.licensed_states.includes(lead.state)) flags.push(`${lead.state} is not in the firm's licensed states`);
        return { lead_id: lead.lead_id, status: lead.status, flags, possible_client_matches: clientMatches(db.tables.Clients, a) };
      });
    },
  },

  list_pipeline: {
    description: "List leads and projects with status, fee and next step. Optional status filter.",
    input: { status: z.string().optional(), limit: z.number().optional() },
    async handler({ status, limit = 50 }) {
      return read((db) => {
        const projects = Object.fromEntries(db.tables.Projects.map((p) => [String(p.project_no), p]));
        const clients = Object.fromEntries(db.tables.Clients.map((c) => [c.client_id, c]));
        const rows = db.tables.Leads.filter((l) => !status || l.status === status).reverse().slice(0, limit).map((l) => {
          const p = projects[String(l.project_no)] || {};
          const scopeN = db.tables.Scope.filter((s) => String(s.project_no) === String(l.project_no)).length;
          const msN = db.tables.Milestones.filter((s) => String(s.project_no) === String(l.project_no)).length;
          let next = "";
          if (l.status === "New") next = "Bid / no-bid decision";
          else if (l.status === "Bid - Preparing Proposal") next = !l.client_id ? "Client" : !l.project_no ? "Create project" : !p.folder_path ? "Folders" : !scopeN ? "Scope" : !p.fee_total ? "Fee" : !msN ? "Milestones" : "Proposal";
          else if (l.status === "Proposal Issued") next = "Record outcome";
          return { lead_id: l.lead_id, received: l.received, project_name: p.name || l.project_name, company: (clients[l.client_id] || {}).company || l.company, status: l.status, project_no: l.project_no || "", fee_total: p.fee_total || "", next_step: next };
        });
        return { count: rows.length, rows };
      });
    },
  },

  get_record: {
    description: "Full record for a lead_id or project_no: lead, client, project, scope, milestones and current fee estimate.",
    input: { ref: z.string().describe("lead_id (L…) or project_no (YYNNN)") },
    async handler({ ref }) {
      return read((db) => {
        const lead = db.tables.Leads.find((l) => l.lead_id === ref || String(l.project_no) === String(ref));
        const project = db.tables.Projects.find((p) => String(p.project_no) === String(ref) || (lead && String(p.project_no) === String(lead.project_no)));
        if (!lead && !project) throw new Error(`No lead or project ${ref}`);
        const client = db.tables.Clients.find((c) => c.client_id === (project?.client_id || lead?.client_id));
        const out = { lead, client, project };
        if (project) {
          out.scope = db.tables.Scope.filter((s) => String(s.project_no) === String(project.project_no)).sort((a, b) => a.line - b.line);
          out.milestones = db.tables.Milestones.filter((m) => String(m.project_no) === String(project.project_no)).sort((a, b) => a.milestone - b.milestone);
          out.fee = feeFor(db, project, getConfig());
          out.project.assumptions = lines(project.assumptions);
          out.project.exclusions = lines(project.exclusions);
        }
        return out;
      });
    },
  },

  decide_bid: {
    description: `Step 2 — Bid / no-bid decision. Optional checklist scores the opportunity (criteria: ${Object.keys(BID_CRITERIA).join(", ")}); licensed-state is checked automatically. no_bid closes the lead.`,
    input: {
      lead_id: z.string(), decision: z.enum(["bid", "no_bid"]), reason: z.string().optional(),
      checklist: z.record(z.string(), z.boolean()).optional(),
    },
    async handler({ lead_id, decision, reason, checklist }) {
      const cfg = getConfig();
      return withStore((db) => {
        const lead = mustFind(db.tables.Leads, "lead_id", lead_id, "Lead");
        const auto = { licensed_state: !lead.state || cfg.firm.licensed_states.includes(String(lead.state).toUpperCase()) };
        const all = { ...auto, ...(checklist || {}) };
        const keys = ["licensed_state", ...Object.keys(BID_CRITERIA)].filter((k) => k in all);
        const score = keys.length ? Math.round((keys.filter((k) => all[k]).length / keys.length) * 100) : "";
        lead.decision = decision === "bid" ? "Bid" : "No Bid";
        lead.decision_reason = reason || "";
        lead.bid_score = score;
        lead.status = decision === "bid" ? "Bid - Preparing Proposal" : "No Bid";
        lead.updated = stamp();
        db.log(lead_id, "decide_bid", `${lead.decision} (${score}%) ${reason || ""}`);
        return {
          lead_id, status: lead.status, bid_score: score, criteria: all,
          warnings: auto.licensed_state ? [] : [`Project state ${lead.state} is outside the firm's licensed states`],
          next: decision === "bid" ? "find_clients / save_client, then create_project" : "Lead closed. Consider a courteous decline reply to the contact.",
        };
      });
    },
  },

  find_clients: {
    description: "Step 3 — Search existing clients by company, contact, email or phone before creating a new one.",
    input: { query: z.string() },
    async handler({ query }) {
      return read((db) => {
        const q = norm(query), d = digits(query);
        const hits = db.tables.Clients.filter((c) =>
          [c.company, c.contact_name, c.email, c.city].some((v) => norm(v).includes(q)) || (d.length >= 4 && digits(c.phone).includes(d)));
        return { count: hits.length, clients: hits };
      });
    },
  },

  save_client: {
    description: "Step 3 — Create a new client (omit client_id) or update one. Pass lead_id to link it to the lead.",
    input: {
      client_id: z.string().optional(), lead_id: z.string().optional(),
      company: z.string().optional(), contact_name: z.string().optional(), title: z.string().optional(),
      phone: z.string().optional(), email: z.string().optional(), address: z.string().optional(),
      city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(),
      billing_contact: z.string().optional(), billing_email: z.string().optional(),
      client_type: z.string().optional().describe("e.g. Owner, Architect, Contractor, Developer, Government"),
      notes: z.string().optional(),
    },
    async handler({ client_id, lead_id, ...f }) {
      return withStore((db) => {
        let c, dupes = [];
        if (client_id) {
          c = mustFind(db.tables.Clients, "client_id", client_id, "Client");
          for (const [k, v] of Object.entries(f)) if (v !== undefined) c[k] = v;
        } else {
          if (!f.company && !f.contact_name) throw new Error("company or contact_name is required");
          dupes = clientMatches(db.tables.Clients, f).map((x) => x.client_id);
          c = { ...f, client_id: nextClientId(db.tables.Clients), created: today() };
          db.tables.Clients.push(c);
        }
        if (lead_id) { const l = mustFind(db.tables.Leads, "lead_id", lead_id, "Lead"); l.client_id = c.client_id; l.updated = stamp(); }
        db.log(c.client_id, client_id ? "update_client" : "create_client", c.company || c.contact_name);
        return { client: c, possible_duplicates: dupes };
      });
    },
  },

  create_project: {
    description: "Step 3/4 — Create the project record and assign the next project number (YYNNN, checked against the workbook and existing folders). Usually called after a bid decision.",
    input: {
      lead_id: z.string().optional(), client_id: z.string().optional(),
      name: z.string(), address: z.string().optional(), city: z.string().optional(), state: z.string().optional(),
      project_type: z.string().describe("One of config project_types (get_settings)"),
      sf: z.number().optional(), construction_value: z.number().optional(),
      expedite: z.enum(["Standard", "Expedited", "Rush"]).optional(),
      start_date: z.string().optional().describe("Anticipated NTP date YYYY-MM-DD"),
      description: z.string().optional().describe("Project understanding paragraph for the proposal"),
      project_no: z.string().optional().describe("Force a specific number (otherwise auto)"),
    },
    async handler(a) {
      const cfg = getConfig();
      if (!cfg.project_types.some((t) => t.name === a.project_type)) throw new Error(`Unknown project_type. Use one of: ${cfg.project_types.map((t) => t.name).join("; ")}`);
      return withStore((db) => {
        const lead = a.lead_id ? mustFind(db.tables.Leads, "lead_id", a.lead_id, "Lead") : null;
        if (lead?.project_no) throw new Error(`Lead ${a.lead_id} already has project ${lead.project_no}`);
        const client_id = a.client_id || lead?.client_id || "";
        const project_no = a.project_no || nextProjectNo(db.tables.Projects, cfg);
        if (db.tables.Projects.some((p) => String(p.project_no) === String(project_no))) throw new Error(`Project ${project_no} already exists`);
        const p = {
          project_no, lead_id: a.lead_id || "", client_id, name: a.name, address: a.address || "", city: a.city || "",
          state: (a.state || lead?.state || "FL").toUpperCase(), project_type: a.project_type, sf: a.sf ?? "",
          construction_value: a.construction_value ?? "", expedite: a.expedite || "Standard", start_date: a.start_date || "",
          status: "Proposal", description: a.description || lead?.description || "",
          assumptions: cfg.proposal.default_assumptions.join("\n"), exclusions: cfg.proposal.default_exclusions.join("\n"),
          proposal_rev: 0, created: today(), updated: stamp(),
        };
        db.tables.Projects.push(p);
        if (lead) { lead.project_no = project_no; if (client_id) lead.client_id = client_id; lead.updated = stamp(); }
        db.log(project_no, "create_project", a.name);
        return { project_no, project: p, warnings: client_id ? [] : ["No client linked yet — save_client with this lead, or pass client_id."] };
      });
    },
  },

  update_project: {
    description: "Edit project fields (name, address, type, SF, construction value, expedite, start date, description, status).",
    input: {
      project_no: z.string(), name: z.string().optional(), address: z.string().optional(), city: z.string().optional(),
      state: z.string().optional(), project_type: z.string().optional(), sf: z.number().optional(),
      construction_value: z.number().optional(), expedite: z.enum(["Standard", "Expedited", "Rush"]).optional(),
      start_date: z.string().optional(), description: z.string().optional(), status: z.string().optional(), client_id: z.string().optional(),
    },
    async handler({ project_no, ...f }) {
      return withStore((db) => {
        const p = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        for (const [k, v] of Object.entries(f)) if (v !== undefined) p[k] = v;
        p.updated = stamp();
        db.log(project_no, "update_project", Object.keys(f).join(", "));
        if (p.fee_detail) { // SF / value / type / schedule changes move the fee
          const fee = feeFor(db, p, getConfig());
          p.fee_design = fee.design_fee; p.fee_addons = fee.addon_fee; p.fee_total = fee.total;
        }
        return { project: p };
      });
    },
  },

  folder_options: {
    description: "Step 4 — List the available project folder templates (name, default on/off, subfolders) and the projects root path.",
    input: {},
    async handler() {
      const cfg = getConfig();
      return { projects_root: cfg.projectsRoot, root_exists: fs.existsSync(cfg.projectsRoot), templates: cfg.folder_templates };
    },
  },

  generate_folders: {
    description: "Step 4 — Build a Windows .bat (returned as `script`, save as `filename`) that creates the project folder '<project_no> - <name>' on the projects drive with the selected template folders (omit folders for defaults). Nothing is created until the .bat is run; re-running it leaves existing folders alone.",
    input: {
      project_no: z.string(), folders: z.array(z.string()).optional().describe("Top-level template folder names to include"),
      extra: z.array(z.string()).optional().describe("Additional custom subfolders, e.g. '04_Design/Wind'"),
    },
    async handler({ project_no, folders, extra }) {
      const cfg = getConfig();
      return withStore((db) => {
        const p = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        const r = folderScript({ cfg, projectNo: p.project_no, name: p.name, selection: folders, extra });
        p.folder_path = r.base; p.updated = stamp();
        db.log(project_no, "generate_folders", `script for ${r.count} folder(s): ${r.folders.join(", ")}`);
        return r;
      });
    },
  },

  list_documents: {
    description: "Step 5 — List the client documents (drawings, specs, RFP, geotech…) uploaded for a project in the web app. Read each with read_document to draft the scope.",
    input: { project_no: z.string() },
    async handler({ project_no }) {
      const cfg = getConfig();
      await read((db) => mustFind(db.tables.Projects, "project_no", project_no, "Project"));
      return { project_no, documents: listDocs(cfg, project_no) };
    },
  },

  set_scope: {
    description: "Step 5 — Define deliverables / scope lines (drawings, calculations, drafting, letters, reports, inspections, CA…), plus assumptions and exclusions. replace=true (default) replaces all existing lines.",
    input: {
      project_no: z.string(), lines: z.array(lineSchema),
      assumptions: z.array(z.string()).optional(), exclusions: z.array(z.string()).optional(),
      description: z.string().optional(), replace: z.boolean().optional(),
    },
    async handler({ project_no, lines: input, assumptions, exclusions, description, replace = true }) {
      const cfg = getConfig();
      return withStore((db) => {
        const p = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        const unknown = input.filter((l) => !cfg.deliverable_types.some((d) => d.type === l.type)).map((l) => l.type);
        if (unknown.length) throw new Error(`Unknown deliverable type(s): ${unknown.join(", ")}. Valid: ${cfg.deliverable_types.map((d) => d.type).join("; ")}`);
        if (replace) db.tables.Scope = db.tables.Scope.filter((s) => String(s.project_no) !== String(project_no));
        let n = db.tables.Scope.filter((s) => String(s.project_no) === String(project_no)).length;
        for (const l of input) {
          const priced = priceLine(l, cfg);
          db.tables.Scope.push({ project_no, line: ++n, type: l.type, description: l.description || "", pool: priced.pool, basis: priced.basis,
            rate_key: priced.rate_key, hours: priced.hours, rate: priced.rate, qty: priced.qty, unit: priced.unit, unit_fee: priced.unit_fee, fee: priced.fee });
        }
        if (assumptions) p.assumptions = assumptions.join("\n");
        if (exclusions) p.exclusions = exclusions.join("\n");
        if (description !== undefined) p.description = description;
        p.updated = stamp();
        db.log(project_no, "set_scope", `${input.length} line(s)`);
        // If a fee was already saved, re-price it with the same method choices so stored totals don't go stale.
        let repriced = null;
        if (p.fee_detail) {
          const fee = feeFor(db, p, cfg);
          p.fee_design = fee.design_fee; p.fee_addons = fee.addon_fee; p.fee_total = fee.total;
          for (const m of db.tables.Milestones.filter((x) => String(x.project_no) === String(project_no))) m.billing_amount = Math.round((fee.design_fee * Number(m.billing_pct)) / 100);
          repriced = { design_fee: fee.design_fee, addon_fee: fee.addon_fee, total: fee.total };
        }
        return { project_no, lines: db.tables.Scope.filter((s) => String(s.project_no) === String(project_no)), repriced };
      });
    },
  },

  estimate_fee: {
    description: "Step 6 — Estimate the fee: averages hourly build-up, $/SF, FL DMS curve and historic comparables (whichever apply), × expedite multiplier, plus per-unit add-ons (inspections etc.). Toggle methods, set a design-fee override, and save to the project.",
    input: {
      project_no: z.string(),
      methods: z.object({ hourly: z.boolean().optional(), area: z.boolean().optional(), dms: z.boolean().optional(), historic: z.boolean().optional() }).optional(),
      design_override: z.number().optional().describe("Fixed design fee $ (bypasses the average); 0 clears it"),
      sf_rate: z.number().optional().describe("$/SF for the area method on this project; 0 = config default"),
      dms_fee: z.number().optional().describe("Fee curve $ entered by hand (replaces the calculated curve fee); 0 clears it"),
      historic_fee: z.number().optional().describe("Historic comparables $ entered by hand (replaces the calculated figure); 0 clears it"),
      expedite: z.enum(["Standard", "Expedited", "Rush"]).optional(),
      sf: z.number().optional(), construction_value: z.number().optional().describe("0 clears it"),
      save: z.boolean().optional().describe("Default true; false = what-if only"),
    },
    async handler({ project_no, methods, expedite, sf, construction_value, save = true, ...given }) {
      const cfg = getConfig();
      const run = (db) => {
        const p0 = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        const p = save ? p0 : { ...p0 };
        if (expedite) p.expedite = expedite;
        if (sf !== undefined) p.sf = sf || "";
        if (construction_value !== undefined) p.construction_value = construction_value || "";
        const prev = parseJSON(p.fee_detail, {}).options || {};
        const options = { methods: { ...(prev.methods || {}), ...(methods || {}) } };
        for (const k of ["design_override", "sf_rate", "dms_fee", "historic_fee"]) options[k] = given[k] !== undefined ? given[k] : prev[k];
        const scope = db.tables.Scope.filter((s) => String(s.project_no) === String(project_no));
        const fee = estimateFee({ project: p, lines: scope, history: db.tables.FeeHistory, cfg, options });
        if (save) {
          p.fee_design = fee.design_fee; p.fee_addons = fee.addon_fee; p.fee_total = fee.total;
          p.fee_detail = JSON.stringify({ options, base: fee.base, methods: fee.methods.map(({ key, fee: f, enabled }) => ({ key, fee: Math.round(f), enabled })) });
          p.updated = stamp();
          db.log(project_no, "estimate_fee", `total ${fee.total}`);
        }
        if (!scope.length) fee.warnings.push("No scope lines yet — hourly method and add-ons are empty.");
        return fee;
      };
      return save ? withStore(run) : read(run);
    },
  },

  set_milestones: {
    description: "Step 7 — Set submittal milestones (any of 35/50/75/100 %). Target dates default from the NTP/start date and config weeks, compressed for Expedited/Rush; billing % defaults to the increment between milestones.",
    input: {
      project_no: z.string(), milestones: z.array(z.number()).optional(), start_date: z.string().optional(),
      dates: z.record(z.string(), z.string()).optional().describe('Override dates, e.g. {"35":"2026-11-14"}'),
      billing_pct: z.record(z.string(), z.number()).optional(), notes: z.record(z.string(), z.string()).optional(),
    },
    async handler({ project_no, ...opts }) {
      const cfg = getConfig();
      return withStore((db) => {
        const p = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        if (opts.start_date) p.start_date = opts.start_date;
        const rows = milestoneRows(p, cfg, opts);
        const total = rows.reduce((s, r) => s + r.billing_pct, 0);
        for (const r of rows) r.billing_amount = p.fee_design ? Math.round((Number(p.fee_design) * r.billing_pct) / 100) : "";
        db.tables.Milestones = db.tables.Milestones.filter((m) => String(m.project_no) !== String(project_no)).concat(rows);
        p.updated = stamp();
        db.log(project_no, "set_milestones", rows.map((r) => `${r.milestone}%@${r.target_date}`).join(", "));
        return { project_no, milestones: rows, warnings: Math.abs(total - 100) > 0.01 ? [`Billing percentages total ${total}%, not 100%`] : [] };
      });
    },
  },

  set_terms: {
    description: "Edit the project's proposal assumptions and exclusions (one item per array entry).",
    input: { project_no: z.string(), assumptions: z.array(z.string()).optional(), exclusions: z.array(z.string()).optional() },
    async handler({ project_no, assumptions, exclusions }) {
      return withStore((db) => {
        const p = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        if (assumptions) p.assumptions = assumptions.join("\n");
        if (exclusions) p.exclusions = exclusions.join("\n");
        p.updated = stamp();
        return { assumptions: lines(p.assumptions), exclusions: lines(p.exclusions) };
      });
    },
  },

  generate_proposal: {
    description: "Step 8 — Generate the proposal PDF (letterhead, scope, deliverables & milestones, fee, assumptions, exclusions, terms, acceptance block) into the project's proposal folder. Each run bumps the revision.",
    input: { project_no: z.string(), mark_issued: z.boolean().optional().describe("Default true — sets lead status to Proposal Issued") },
    async handler({ project_no, mark_issued = true }) {
      const cfg = getConfig();
      return withStore(async (db) => {
        const p = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        const client = db.tables.Clients.find((c) => c.client_id === p.client_id) || {};
        const lead = db.tables.Leads.find((l) => l.lead_id === p.lead_id) || {};
        const fee = feeFor(db, p, cfg);
        const ms = db.tables.Milestones.filter((m) => String(m.project_no) === String(project_no)).sort((a, b) => a.milestone - b.milestone);
        const problems = [];
        if (!client.client_id) problems.push("no client linked");
        if (!fee.design_lines.length && !fee.addon_lines.length) problems.push("no scope lines");
        if (!fee.total) problems.push("fee is $0");
        if (problems.length) throw new Error(`Can't generate proposal: ${problems.join("; ")}`);

        const rev = Number(p.proposal_rev || 0) + (p.proposal_path ? 1 : 0);
        const date = today();
        const buf = await buildProposalPdf({ cfg, project: { ...p, assumptions: lines(p.assumptions), exclusions: lines(p.exclusions) }, client, lead, fee, milestones: ms, rev, date });
        const dir = p.folder_path && fs.existsSync(p.folder_path)
          ? path.join(p.folder_path, safeName(cfg.proposal_folder || ""))
          : path.join(APP_DIR, "data", "proposals");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${project_no} - ${cfg.firm.short} Proposal R${rev}.pdf`);
        fs.writeFileSync(file, buf);
        p.proposal_rev = rev; p.proposal_date = date; p.proposal_path = file;
        p.fee_design = fee.design_fee; p.fee_addons = fee.addon_fee; p.fee_total = fee.total;
        for (const m of ms) m.billing_amount = Math.round((fee.design_fee * Number(m.billing_pct)) / 100);
        if (mark_issued && lead.lead_id) { lead.status = "Proposal Issued"; lead.updated = stamp(); }
        p.updated = stamp();
        db.log(project_no, "generate_proposal", `R${rev} ${file}`);
        return { file, revision: rev, total: fee.total, design_fee: fee.design_fee, addon_fee: fee.addon_fee, saved_outside_project_folder: !p.folder_path };
      });
    },
  },

  record_outcome: {
    description: "Close out the proposal: won (project goes Active and is added to FeeHistory for future fee comparables), lost, or on_hold.",
    input: { project_no: z.string(), outcome: z.enum(["won", "lost", "on_hold"]), final_fee: z.number().optional(), notes: z.string().optional() },
    async handler({ project_no, outcome, final_fee, notes }) {
      return withStore((db) => {
        const p = mustFind(db.tables.Projects, "project_no", project_no, "Project");
        const lead = db.tables.Leads.find((l) => l.lead_id === p.lead_id);
        p.status = { won: "Active", lost: "Lost", on_hold: "On Hold" }[outcome];
        if (final_fee) p.fee_total = final_fee;
        if (lead) { lead.status = { won: "Won", lost: "Lost", on_hold: "Proposal Issued" }[outcome]; lead.updated = stamp(); }
        if (outcome === "won") {
          const hrs = db.tables.Scope.filter((s) => String(s.project_no) === String(project_no) && s.basis === "hourly").reduce((s, l) => s + Number(l.hours || 0), 0);
          db.tables.FeeHistory = db.tables.FeeHistory.filter((h) => String(h.project_no) !== String(project_no));
          db.tables.FeeHistory.push({ project_no, name: p.name, project_type: p.project_type, state: p.state, sf: p.sf, construction_value: p.construction_value,
            fee: final_fee || p.fee_total, hours: hrs || "", year: Number(today().slice(0, 4)), source: "proposal (won)", notes: notes || "" });
        }
        p.updated = stamp();
        db.log(project_no, "record_outcome", `${outcome} ${notes || ""}`);
        return { project_no, status: p.status };
      });
    },
  },

  add_history: {
    description: "Add past projects to the FeeHistory sheet so the historic-comparables fee method has data. project_type should match a config project type.",
    input: {
      rows: z.array(z.object({
        project_no: z.string().optional(), name: z.string(), project_type: z.string(), state: z.string().optional(),
        sf: z.number().optional(), construction_value: z.number().optional(), fee: z.number(), hours: z.number().optional(),
        year: z.number().optional(), notes: z.string().optional(),
      })),
    },
    async handler({ rows }) {
      return withStore((db) => {
        for (const r of rows) db.tables.FeeHistory.push({ ...r, source: "manual" });
        db.log("FeeHistory", "add_history", `${rows.length} row(s)`);
        return { added: rows.length, total_history: db.tables.FeeHistory.length };
      });
    },
  },

  parse_email: {
    description: "Read a pasted RFP email / text / call notes and return a draft of lead, client, project and scope fields (with confidence per field), plus existing-client matches. Saves nothing. Review and correct, then pass the corrections to quick_start as overrides.",
    input: { text: z.string().describe("The pasted email including headers and signature if available") },
    async handler({ text }) {
      const cfg = getConfig();
      const draft = parseEmail(text, cfg);
      const matches = await read((db) => clientMatches(db.tables.Clients, draft.lead));
      const st = draft.project.state || draft.lead.state;
      return { ...draft, client_matches: matches, licensed_state: !st || cfg.firm.licensed_states.includes(st),
        low_confidence: Object.entries(draft.confidence).filter(([, c]) => c === "low").map(([k]) => k) };
    },
  },

  quick_start: {
    description: "One-shot intake from a pasted email: parse → log RFP → mark Bid → link or create client → create project & number → default folders → draft scope → fee → default milestones. Stops after intake if the state is unlicensed or steps.bid=false. Overrides (lead/client/project/scope) replace parsed values — use them to fix anything parse_email got wrong. Does NOT generate the proposal unless steps.proposal=true. Confirm with the user before running it with folders on.",
    input: {
      text: z.string().optional().describe("Pasted email; optional if overrides carry everything"),
      overrides: z.object({
        lead: z.record(z.string(), z.any()).optional(), client: z.record(z.string(), z.any()).optional(),
        project: z.record(z.string(), z.any()).optional(), scope: z.array(lineSchema).optional(),
      }).optional(),
      client_id: z.string().optional().describe("Link this existing client instead of matching/creating"),
      steps: z.object({
        bid: z.boolean().optional(), client: z.boolean().optional(), project: z.boolean().optional(), folders: z.boolean().optional(),
        scope: z.boolean().optional(), fee: z.boolean().optional(), milestones: z.boolean().optional(), proposal: z.boolean().optional(),
      }).optional(),
      folders: z.array(z.string()).optional().describe("Folder template names; omit for defaults"),
    },
    async handler({ text, overrides = {}, client_id, steps = {}, folders }) {
      const cfg = getConfig();
      const want = (k, d = true) => (steps[k] === undefined ? d : !!steps[k]);
      const d = text ? parseEmail(text, cfg) : { lead: {}, client: {}, project: {}, scope: [], confidence: {} };
      const lead = { ...d.lead, ...(overrides.lead || {}) };
      const clientF = { ...d.client, ...(overrides.client || {}) };
      const proj = { ...d.project, ...(overrides.project || {}) };
      const scope = (overrides.scope || d.scope).map(({ why, ...l }) => l);
      const done = [], warnings = [];
      const out = { done, warnings };

      // 1 intake
      const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== "").map((k) => [k, o[k]]));
      if (!lead.project_name) lead.project_name = proj.name || "New RFP";
      if (!lead.source) lead.source = "email";
      const intake = await run("intake_rfp", pick({ ...lead, state: lead.state || proj.state }, ["source", "contact_name", "company", "phone", "email", "project_name", "location", "state", "description", "raw_message", "response_due", "received"]));
      out.lead_id = intake.lead_id; done.push(`Logged RFP ${intake.lead_id}`);
      warnings.push(...intake.flags);

      // 2 bid
      const licensed = !intake.flags.length;
      const autoBid = steps.bid === true || (steps.bid === undefined && cfg.email_parser?.auto_bid_default !== false && licensed);
      if (!autoBid) {
        out.stopped_at = "bid";
        out.next = licensed ? "Make the bid / no-bid decision" : "Out-of-license state — decide bid / no-bid manually";
        return out;
      }
      await run("decide_bid", { lead_id: intake.lead_id, decision: "bid", reason: "Auto-bid from email intake (review)" });
      done.push("Marked Bid");

      // 3 client
      if (want("client")) {
        let cid = client_id;
        if (!cid && intake.possible_client_matches.length) {
          const m = intake.possible_client_matches;
          const byEmail = clientF.email && m.find((c) => String(c.email).toLowerCase() === String(clientF.email).toLowerCase());
          cid = (byEmail || m[0]).client_id;
          if (m.length > 1 && !byEmail) warnings.push(`Several existing clients matched; linked ${cid} — check (${m.map((c) => c.client_id).join(", ")})`);
          done.push(`Linked existing client ${cid}`);
          out.client_status = "existing";
        }
        if (cid) await run("save_client", { client_id: cid, lead_id: intake.lead_id });
        else if (clientF.company || clientF.contact_name) {
          const c = await run("save_client", { ...pick(clientF, ["company", "contact_name", "title", "phone", "email", "address", "city", "state", "zip", "billing_contact", "billing_email", "client_type", "notes"]), lead_id: intake.lead_id });
          cid = c.client.client_id; out.client_status = "new"; done.push(`Created client ${cid}`);
        } else warnings.push("No client name or company found — add the client manually");
        out.client_id = cid;
      }

      // 4 project
      if (!want("project")) { out.stopped_at = "project"; return out; }
      const type = cfg.project_types.some((t) => t.name === proj.project_type) ? proj.project_type : "Other";
      const p = await run("create_project", { lead_id: intake.lead_id, client_id: out.client_id,
        ...pick(proj, ["address", "city", "state", "sf", "construction_value", "expedite", "start_date"]),
        sf: proj.sf ? Number(proj.sf) : undefined, construction_value: proj.construction_value ? Number(proj.construction_value) : undefined,
        name: proj.name || lead.project_name, project_type: type, description: proj.description || lead.description });
      out.project_no = p.project_no; done.push(`Created project ${p.project_no} (${type})`);

      if (want("folders")) {
        try { const f = await run("generate_folders", { project_no: p.project_no, folders }); out.folder_path = f.base; done.push(`Created folders (${f.created})`); }
        catch (e) { warnings.push(`Folders not created: ${e.message}`); }
      }
      if (want("scope") && scope.length) {
        try { await run("set_scope", { project_no: p.project_no, lines: scope }); done.push(`Drafted ${scope.length} scope line(s)`); }
        catch (e) { warnings.push(`Scope not set: ${e.message}`); }
      }
      if (want("fee") && scope.length) {
        const f = await run("estimate_fee", { project_no: p.project_no });
        out.fee = { design_fee: f.design_fee, addon_fee: f.addon_fee, total: f.total, methods: f.methods.filter((m) => m.enabled).map((m) => `${m.label}: $${Math.round(m.fee).toLocaleString()}`) };
        warnings.push(...f.warnings); done.push(`Estimated fee $${f.total.toLocaleString()}`);
      }
      if (want("milestones")) {
        const ms = await run("set_milestones", { project_no: p.project_no });
        done.push(`Set milestones ${ms.milestones.map((m) => m.milestone + "%").join("/")}`);
      }
      if (want("proposal", false) && out.fee) {
        const g = await run("generate_proposal", { project_no: p.project_no, mark_issued: false });
        out.proposal = g.file; done.push(`Generated proposal R${g.revision}`);
      }
      out.review = Object.entries(d.confidence || {}).filter(([, c]) => c === "low").map(([k]) => k);
      out.next = out.proposal ? "Review the PDF, then mark the lead Proposal Issued" : "Review scope and fee, then generate the proposal";
      return out;
    },
  },

  get_settings: {
    description: "Return configuration: rates, fee model, project types, deliverable catalog, milestone defaults, folder templates, proposal boilerplate, firm info.",
    input: {},
    async handler() { const { workbookPath, projectsRoot, ...c } = getConfig(); return { ...c, workbook_resolved: workbookPath, projects_root_resolved: projectsRoot, bid_criteria: BID_CRITERIA, lead_statuses: LEAD_STATUSES }; },
  },

  update_settings: {
    description: "Update configuration sections (e.g. rates, fee_model, projects_root, folder_templates, proposal). Objects are merged one level deep; arrays replace.",
    input: { patch: z.record(z.string(), z.any()) },
    async handler({ patch }) {
      const blocked = ["workbook"].filter((k) => k in patch);
      if (blocked.length) throw new Error(`Change ${blocked.join(", ")} by editing config.json directly.`);
      const cfg = updateConfig(patch);
      return { ok: true, rates: cfg.rates, fee_model: cfg.fee_model, projects_root: cfg.projectsRoot };
    },
  },
};

async function run(name, args) {
  const a = actions[name];
  if (!a) throw new Error(`Unknown action ${name}`);
  const parsed = z.object(a.input).parse(args || {});
  return a.handler(parsed);
}

module.exports = { actions, run, BID_CRITERIA };
