# TNSE Project Manager

New-project lifecycle for True North Structural Engineering — RFP intake through a signed-ready proposal PDF.
Two front doors onto the same data:

- **MCP server** – Claude (Claude Desktop) runs the lifecycle by conversation: *"Log this email as an RFP, we'll bid it, set up the project with the usual folders and price it for 3 inspections."*
- **Web app** – a local page with the same 8 steps as forms, fee comparison, PDF preview and generation.

Both read and write one Excel workbook (`data/TNSE_Projects.xlsx`) and create folders on your projects drive.

## Fastest path: paste the email

**Web app** – click **+ New RFP**, paste the whole email (headers and signature help), click **Read email**. A review form opens with everything it found; fields tagged **check** are guesses and ⓘ shows where each value came from. Fix what's wrong, choose what to automate, click **Create project**. You land on the Fee step with the lead logged, bid marked, client linked or created, project numbered, folders built, scope drafted, fee estimated and milestones set.

**Claude Desktop** – paste the email and say "set this up", or pick the **New RFP from email** prompt from the tnse-project-manager connector's prompts. Claude runs `parse_email`, cross-checks the draft against its own reading of the email, shows you a summary, and runs `quick_start` once you confirm. Claude catches things the rule-based reader can't (unusual phrasing, scope buried in long threads).

What the reader picks up:

| Field | From |
|---|---|
| Contact, email | From header, signature, "my name is / this is…" |
| Phone | Signature first; cell preferred over office; your own number ignored |
| Company, title, client type | Signature line matching the email domain, company words (LLC, Builders, Church, County…), title words |
| Client mailing address | Address in the signature |
| Site address, city, state | "Project address:" / "Location:" lines, street addresses in the body (incl. Hwy/SR/US routes), City ST ZIP, known Panhandle / Baldwin County towns |
| SF / value | "2,400 SF", "18k sf", 60' x 150' dimensions; "budget of $650,000" |
| Due date | "by Friday", "due Nov 6", "by 11/3", "next week"… relative to the email's Sent date |
| Project type | Keyword scores (subject counts double) |
| Schedule | ASAP / urgent → Expedited; emergency / tomorrow → Rush |
| Scope | Deliverable keywords + counts ("3 inspections", "two site visits"), plus defaults by project type |
| Project name | Subject line, or *address + service* for assessments / letters / repairs / walls (your folder convention) |

Forwarded emails and reply chains use the client's message, not yours. Out-of-license states are logged but not auto-bid. Letters, reports and small jobs default to a single 100% milestone; building design gets 35/50/75/100.

Tune it in `config.json → email_parser`: keyword lists per project type and deliverable, rush/expedite words, `known_cities` (e.g. `"known_cities": {"Elberta": "AL"}`), and `auto_bid_default`.

## Lifecycle

| # | Step | MCP tool(s) | Notes |
|---|------|-------------|-------|
| 1 | RFP intake (phone / text / email) | `intake_rfp` | Paste the raw message; flags out-of-license states and existing-client matches |
| 2 | Bid / no-bid | `decide_bid` | Checklist score; licensed-state checked automatically. **No bid closes the lead** |
| 3 | Client | `find_clients`, `save_client` | Dedupes by email, phone, company, contact |
| 4 | Project & folders | `create_project`, `folder_options`, `generate_folders` | Next number `YYNNN`, checked against the workbook **and** existing folders on the drive |
| 5 | Scope / deliverables | `set_scope`, `set_terms` | Drawings, calcs, drafting, letters, reports (design pool); inspections, site visits, CA, shop-drawing review (add-ons) |
| 6 | Fee | `estimate_fee` | See below |
| 7 | Milestones | `set_milestones` | Any of 35/50/75/100 %, dates from NTP, compressed for Expedited/Rush |
| 8 | Proposal PDF | `generate_proposal` | Saved to `<project folder>\02_Contract & Proposal\<no> - TNSE Proposal R#.pdf` |
| – | Close-out | `record_outcome` | Won → project Active and added to FeeHistory |
| – | Email intake | `parse_email`, `quick_start` | See "Fastest path" above |
| – | Utilities | `list_pipeline`, `get_record`, `update_project`, `add_history`, `get_settings`, `update_settings` | |

### Fee model

**Design fee** = average of the methods that apply (each can be switched off per project) × schedule multiplier, rounded to $50:

1. **Hourly build-up** – design scope lines, hours × rate
2. **Area** – SF × $1.75/SF
3. **FL DMS curve** – construction value (or SF × $225) × curve % × building-type factor × 20 % structural share — same approximated curve as your fee calculator
4. **Historic comparables** – median $/SF of same-type projects within 0.33–3× the SF (needs ≥ 3)

Area and DMS methods only apply to building-design project types (set per type in `config.json`). A warning shows when the methods disagree by more than 2.5×. A design-fee override bypasses the average.

**Add-ons** (inspections, site visits, CA, reviews) are priced per unit or hourly and added on top — not averaged, not multiplied.

Schedule: Standard ×1.00, Expedited ×1.25 (schedule ×0.7), Rush ×1.5 (×0.5).

## Install (Windows)

1. Install Node.js 20+ (nodejs.org).
2. Copy this folder somewhere permanent, e.g. `C:\TNSE\tnse-pm`, then in that folder:
   ```
   npm install
   ```
3. Edit `config.json`:
   - `"projects_root": "P:\\Projects"` – your projects drive (double backslashes; UNC like `"\\\\server\\Projects"` works)
   - `"workbook"` – leave as is, or point at a shared location
   - check `rates` (eit / drafting / admin are placeholders), `proposal` boilerplate, and `folder_templates`
4. `npm run init` – creates the workbook and confirms the projects root is reachable.

### Web app
Double-click **Start Web App.bat** (or `npm run web`) → http://localhost:4180. It listens on this computer only. To let the office reach it, set `"web_host": "0.0.0.0"` in `config.json`.

### Claude Desktop (MCP)
Add to `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "tnse-projects": {
      "command": "node",
      "args": ["C:\\TNSE\\tnse-pm\\src\\mcp-server.js"]
    }
  }
}
```

The server runs on your machine, so it can reach your drives. The web app and MCP server can run at the same time.

## Working notes

- **Close the workbook in Excel before saving from the app.** Windows locks open files; the app will tell you if it can't save. Use Excel for reading, filtering and adding history — columns you add are preserved.
- **Seed history** – paste past projects into the `FeeHistory` sheet (`project_type` must match a type in `config.json`, `fee` required, `sf` strongly recommended), or ask Claude to `add_history` from old proposals/invoices. Won projects are added automatically.
- **Revisions** – each `generate_proposal` writes a new `R#`. The web app's *Preview* renders without saving.
- **Revit template** – fill `seed_files` in `config.json` (`"from": "C:\\...\\TNSE Template.rte", "to": "05_Revit"`) and it is copied into every new project.
- **DMS curve** – approximation, editable in Settings → Advanced. Run a couple of projects through the official DMS calculator and adjust the points.

## Files

```
config.json            paths, rates, fee model, catalogs, folder templates, proposal boilerplate
src/lifecycle.js       all actions (shared by MCP + web)
src/parse-email.js     pasted-email reader
src/fee.js             fee methods
src/folders.js         folder generation / numbering
src/proposal.js        PDF layout
src/store.js           Excel workbook store (lock + atomic save)
src/mcp-server.js      MCP server (stdio)
src/web-server.js      web app server
public/index.html      web app UI
```
