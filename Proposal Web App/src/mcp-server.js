#!/usr/bin/env node
// TNSE Project Manager — MCP server (stdio). Exposes every lifecycle action as a tool.
// Claude Desktop config: see README.md.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { actions, run } = require("./lifecycle");
const { getConfig } = require("./config");
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
      "Ask the user before generate_folders (writes to the projects drive) and before generate_proposal if the fee has not been reviewed.",
      "Values in deliverable_types / project_types must match get_settings exactly.",
    ].join(" "),
  }
);

const READ_ONLY = new Set(["list_pipeline", "get_record", "find_clients", "folder_options", "get_settings", "parse_email"]);

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
