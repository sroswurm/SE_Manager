import { z } from "zod";
import { readTable, writeTable } from "../storage.js";
export function registerCreateProject(server) {
    server.tool("create_project", "Create a new structural engineering project. WORKFLOW: If the user has not specified a client, always ask 'Who is the client?' first before gathering any other project details. Then use search_clients to check if they already exist. Provide either a clientId for an existing client, or client details (clientName, etc.) to create a new one.", {
        clientId: z.string().optional().describe("Existing client ID (from search_clients)"),
        clientName: z.string().optional().describe("Client or company name (for new client)"),
        contactName: z.string().optional().describe("Primary contact person"),
        contactEmail: z.string().optional().describe("Contact email"),
        contactPhone: z.string().optional().describe("Contact phone"),
        clientAddress: z.string().optional().describe("Client mailing address"),
        projectName: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description / scope summary"),
        category: z.enum([
            "residential", "commercial", "industrial",
            "institutional", "infrastructure", "mixed-use",
        ]).describe("Project type category"),
        subtype: z.string().optional().describe("Project subtype (e.g. addition, tenant_improvement, bridge)"),
        address: z.string().optional().describe("Project site address"),
        deliverables: z.array(z.object({
            name: z.string(),
            description: z.string().optional(),
        })).optional().default([]).describe("What the SE firm will produce"),
        deadlines: z.array(z.object({
            name: z.string(),
            dueDate: z.string().optional(),
            notes: z.string().optional(),
        })).optional().default([]).describe("Key deadlines"),
        notes: z.string().optional().describe("Additional notes"),
    }, async (args) => {
        if (!args.clientId && !args.clientName) {
            return {
                content: [{
                        type: "text",
                        text: "I need to know who the client is before creating a project. Ask the user for the client name, then use search_clients to check if they already exist in the system.",
                    }],
                isError: true,
            };
        }
        const clients = await readTable("clients.json");
        let resolvedClient;
        let isNewClient = false;
        if (args.clientId) {
            const existing = clients.find((c) => c.id === args.clientId);
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
        }
        else {
            const now = new Date().toISOString();
            resolvedClient = {
                id: crypto.randomUUID(),
                name: args.clientName,
                contactName: args.contactName,
                contactEmail: args.contactEmail,
                contactPhone: args.contactPhone,
                address: args.clientAddress,
                createdAt: now,
                updatedAt: now,
            };
            clients.push(resolvedClient);
            isNewClient = true;
        }
        const now = new Date().toISOString();
        const projectId = crypto.randomUUID();
        const newProject = {
            id: projectId,
            clientId: resolvedClient.id,
            name: args.projectName,
            description: args.description,
            category: args.category,
            subtype: args.subtype,
            address: args.address,
            notes: args.notes,
            status: "intake",
            createdAt: now,
            updatedAt: now,
        };
        const deliverableRows = args.deliverables.map((d) => ({
            id: crypto.randomUUID(),
            projectId,
            name: d.name,
            description: d.description,
            status: "pending",
            createdAt: now,
            updatedAt: now,
        }));
        const deadlineRows = args.deadlines.map((d) => ({
            id: crypto.randomUUID(),
            projectId,
            name: d.name,
            dueDate: d.dueDate,
            notes: d.notes,
            status: "upcoming",
            createdAt: now,
            updatedAt: now,
        }));
        await writeTable("clients.json", clients);
        const projects = await readTable("projects.json");
        projects.push(newProject);
        await writeTable("projects.json", projects);
        if (deliverableRows.length > 0) {
            const deliverables = await readTable("deliverables.json");
            deliverables.push(...deliverableRows);
            await writeTable("deliverables.json", deliverables);
        }
        if (deadlineRows.length > 0) {
            const deadlines = await readTable("deadlines.json");
            deadlines.push(...deadlineRows);
            await writeTable("deadlines.json", deadlines);
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        message: `Project "${args.projectName}" created successfully.`,
                        project: newProject,
                        client: resolvedClient,
                        isNewClient,
                        deliverables: deliverableRows,
                        deadlines: deadlineRows,
                    }, null, 2),
                }],
        };
    });
}
