#!/usr/bin/env node
// TNSE Project Manager — MCP server (stdio). Exposes every lifecycle action as a tool.
// Claude Desktop config: see README.md.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { actions, run } = require("./lifecycle");
const { getConfig } = require("./config");
const { readDoc } = require("./documents");
const { z } = require("zod");

const server = new McpServer(
  { name: "tnse-project-manager", version: "1.0.0" },
  {
    instructions: [
      "TNSE new-project lifecycle.",
      "FASTEST PATH — when the user pastes an RFP email/text: call parse_email, read the email yourself and correct anything the rule-based draft got wrong or missed (contact, company, site address, state, SF, project type, deliverables and inspection counts, due date, schedule), show a short summary with uncertain items flagged, and after the user confirms call quick_start with the same text plus your corrections as overrides.",
      "Step-by-step order:",
      "1 intake_rfp → 2 decide_bid (stop if no_bid) → 3 find_clients, then save_client if new →",
      "create_project → 4 folder_options / generate_folders → 5 set_scope → 6 estimate_fee →",
      "7 set_milestones → 8 generate_proposal → record_outcome when the client responds.",
      "Use list_pipeline to see where each lead stands and get_record for full detail.",
      "SCOPE FROM DOCUMENTS — when asked to draft or automate the scope: list_documents, read_document every file, then set_scope from what the documents show (see the draft_scope_from_documents prompt).",
      "Ask the user before generate_folders (writes to the projects drive) and before generate_proposal if the fee has not been reviewed.",
      "Values in deliverable_types / project_types must match get_settings exactly.",
    ].join(" "),
  }
);

const READ_ONLY = new Set(["list_pipeline", "get_record", "find_clients", "folder_options", "get_settings", "parse_email", "list_documents"]);

for (const [name, a] of Object.entries(actions)) {
  server.registerTool(
    name,
    {
      description: a.description,
      inputSchema: a.input,
      annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await run(name, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e.issues ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e.message;
        return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    }
  );
}

// MCP-only: returns the document as text or an image block rather than JSON.
server.registerTool(
  "read_document",
  {
    description: "Step 5 — Read one client document from list_documents. PDFs, Word and Excel come back as text (page by page; long files in chunks — pass the start the result asks for), images as images.",
    inputSchema: { project_no: z.string(), name: z.string().describe("File name exactly as list_documents shows it"), start: z.number().optional().describe("Character offset for the next chunk of a long document") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ project_no, name, start }) => {
    try {
      return { content: await readDoc(getConfig(), project_no, name, { start }) };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.registerPrompt(
  "draft_scope_from_documents",
  {
    title: "Draft scope from client documents",
    description: "Claude reads the documents uploaded for a project and fills in its scope, assumptions and exclusions.",
    argsSchema: { project_no: z.string().describe("Project number, e.g. 26001") },
  },
  ({ project_no }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Draft the scope of work for project ${project_no} from the client documents.`,
          `1. Call get_record for ${project_no} and get_settings (deliverable_types, rates, project_types).`,
          "2. Call list_documents, then read_document on every file (keep reading long ones with the start offset it gives).",
          "3. From the documents work out: what is being built or repaired, building/project type, SF, stories, construction value if stated, structural systems and materials, foundation/geotech information, wind/code criteria, and what the client is asking TNSE to deliver.",
          "4. Call set_scope with lines using deliverable types exactly as in the catalog. Write each description as it should print on the proposal, specific to this project. Estimate hours for hourly lines from the size and complexity you saw; give counts (qty) for inspections, site visits and submittal reviews. Include a project-understanding description, and assumptions and exclusions tailored from the project's current ones.",
          "   If the project already has scope lines, show me them next to your draft and ask before replacing them.",
          "5. If the documents give a different SF, construction value or project type than the project record, call update_project.",
          "6. Summarize what you set (lines with hours/qty and why), which documents you used, and anything unclear I should confirm. Tell me to reload the Scope step in the web app.",
        ].join("\n"),
      },
    }],
  })
);

server.registerPrompt(
  "rfp_from_email",
  {
    title: "New RFP from email",
    description: "Paste an RFP email or text; Claude drafts the lead, client, project, scope and fee for your confirmation.",
    argsSchema: { email: z.string().describe("Paste the full email, including the signature") },
  },
  ({ email }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          "Set up a new TNSE project from this RFP.",
          "1. Call parse_email on it.",
          "2. Read the email yourself and fix anything the draft got wrong or missed: contact, company, client type, site address/city/state, SF, construction value, project type, deliverables (with inspection/site-visit counts), response due date, schedule.",
          "3. Give me a compact summary: client (new or existing match), project name/type/location/size, scope lines, schedule, due date. Flag out-of-license states and anything you're unsure of.",
          "4. When I confirm, call quick_start with the same text and your corrections as overrides.",
          "5. Report the project number, folder, fee by method, and what I should review before generating the proposal.",
          "",
          "EMAIL:",
          email,
        ].join("\n"),
      },
    }],
  })
);

(async () => {
  getConfig(); // fail fast on a broken config.json
  await server.connect(new StdioServerTransport());
  console.error("TNSE Project Manager MCP server running (stdio)");
})();
