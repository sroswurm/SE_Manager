import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readTable, writeTable } from "../storage.js";
import type { Client, Project, ClientType } from "../types.js";

const addressSchema = z.object({
  street: z.string(),
  unit: z.string().nullish(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  county: z.string(),
});

const contactSchema = z.object({
  name: z.string(),
  title: z.string().nullish(),
  email: z.string(),
  phone: z.string(),
  address: addressSchema.nullish(),
});

export function registerCreateProject(server: McpServer): void {
  server.tool(
    "create_project",
    `Create a new structural engineering project. WORKFLOW: If the user has not specified a client, always ask "Who is the client?" first. Then use search_clients to check if they already exist. Provide either a clientId for an existing client, or client details to create a new one.`,
    {
      clientId: z.string().optional().describe("Existing client GUID (from search_clients)"),

      clientEntity: z.string().optional().describe("Client or company name (for new client)"),
      clientType: z.enum(["architect", "fabricator", "contractor", "owner", "developer"]).optional().describe("Client type"),
      clientAddress: addressSchema.optional().describe("Client mailing address"),
      clientContacts: z.array(contactSchema).optional().default([]).describe("Client contact(s)"),
      billingContactIndex: z.number().optional().default(0).describe("Index into contacts array for billing"),
      defaultTermsDays: z.number().optional().default(30).describe("Payment terms in days"),
      referralSource: z.string().optional().describe("How the client found us"),

      location: addressSchema.optional().describe("Project site address"),
      structuralMaterial: z.array(z.string()).optional().default([]).describe("Structural materials (e.g. Wood, Steel, Concrete)"),
      scope: z.string().describe("Project scope description"),
      deliverables: z.array(z.string()).optional().default([]).describe("List of deliverables"),
      feeType: z.enum(["Lump Sum", "Not To Exceed", "Hourly", "Time & Materials"]).optional().default("Lump Sum").describe("Fee structure"),
      notes: z.string().optional().describe("Additional notes"),
    },
    async (args) => {
      if (!args.clientId && !args.clientEntity) {
        return {
          content: [{
            type: "text",
            text: "I need to know who the client is before creating a project. Ask the user for the client name, then use search_clients to check if they already exist in the system.",
          }],
          isError: true,
        };
      }

      const clients = await readTable("clients.json");

      let resolvedClient: Client;
      let isNewClient = false;

      if (args.clientId) {
        const existing = clients.find((c) => c.client_id === args.clientId);
        if (!existing) {
          return {
            content: [{
              type: "text",
              text: `Error: No client found with ID "${args.clientId}". Use search_clients to find the correct ID.`,
            }],
            isError: true,
          };
        }
        resolvedClient = existing;
      } else {
        resolvedClient = {
          client_id: crypto.randomUUID(),
          entity: args.clientEntity!,
          type: (args.clientType ?? "owner") as ClientType,
          address: args.clientAddress ?? { street: "", city: "", state: "", zip: "", county: "" },
          contacts: args.clientContacts,
          billing_contact_index: args.billingContactIndex,
          default_terms_days: args.defaultTermsDays,
          referral_source: args.referralSource ?? "",
        };
        clients.push(resolvedClient);
        isNewClient = true;
      }

      const projectId = crypto.randomUUID();

      const newProject: Project = {
        project_id: projectId,
        client_id: resolvedClient.client_id,
        client_status: isNewClient ? "new" : "existing",
        location: args.location ?? { street: "", city: "", state: "", zip: "", county: "" },
        structural_material: args.structuralMaterial,
        scope: args.scope,
        deliverables: args.deliverables,
        fee_type: args.feeType,
        notes: args.notes,
      };

      await writeTable("clients.json", clients);

      const projects = await readTable("projects.json");
      projects.push(newProject);
      await writeTable("projects.json", projects);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            message: `Project created successfully.`,
            project: newProject,
            client: resolvedClient,
            isNewClient,
          }, null, 2),
        }],
      };
    }
  );
}
