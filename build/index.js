import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDataDir } from "./storage.js";
import { registerCreateProject } from "./tools/create-project.js";
import { registerSearchClients } from "./tools/search-clients.js";
const server = new McpServer({
    name: "se-manager",
    version: "0.1.0",
});
registerSearchClients(server);
registerCreateProject(server);
await ensureDataDir();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("SE Manager MCP server running on stdio");
