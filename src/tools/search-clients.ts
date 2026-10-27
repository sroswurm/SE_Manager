import { z } from "zod";
import Fuse from "fuse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readTable } from "../storage.js";

export function registerSearchClients(server: McpServer): void {
  server.tool(
    "search_clients",
    "Search for existing clients by name (fuzzy match). Use this before create_project to check if a client already exists.",
    {
      query: z.string().describe("Client name or partial name to search for"),
      limit: z.number().optional().default(5).describe("Maximum results to return"),
    },
    async ({ query, limit }) => {
      const clients = await readTable("clients.json");

      if (clients.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ matches: [], total: 0, message: "No clients in the system yet." }, null, 2),
          }],
        };
      }

      const fuse = new Fuse(clients, {
        keys: ["entity", "contacts.name"],
        threshold: 0.4,
        includeScore: true,
      });

      const results = fuse.search(query, { limit });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            matches: results.map((r) => ({
              client_id: r.item.client_id,
              entity: r.item.entity,
              type: r.item.type,
              contacts: r.item.contacts.map((c) => c.name),
              score: r.score,
            })),
            total: results.length,
          }, null, 2),
        }],
      };
    }
  );
}
