export type ProjectCategory =
  | "residential"
  | "commercial"
  | "industrial"
  | "institutional"
  | "infrastructure"
  | "mixed-use";

export const PROJECT_SUBTYPES: Record<ProjectCategory, string[]> = {
  residential: ["new_home", "addition", "renovation", "adu", "deck_patio", "foundation_repair"],
  commercial: ["office", "retail", "tenant_improvement", "restaurant", "hotel"],
  industrial: ["warehouse", "manufacturing", "cold_storage", "loading_dock"],
  institutional: ["school", "hospital", "government", "religious", "library"],
  infrastructure: ["bridge", "retaining_wall", "foundation", "shoring", "culvert"],
  "mixed-use": ["residential_over_retail", "live_work", "podium", "other"],
};

export interface Client {
  id: string;
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  clientId: string;
  name: string;
  description?: string;
  category: ProjectCategory;
  subtype?: string;
  address?: string;
  notes?: string;
  status: "intake" | "active" | "on_hold" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface Deliverable {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  status: "pending" | "in_progress" | "complete";
  createdAt: string;
  updatedAt: string;
}

export interface Deadline {
  id: string;
  projectId: string;
  name: string;
  dueDate?: string;
  notes?: string;
  status: "upcoming" | "complete" | "overdue";
  createdAt: string;
  updatedAt: string;
}

export type TableMap = {
  "clients.json": Client;
  "projects.json": Project;
  "deliverables.json": Deliverable;
  "deadlines.json": Deadline;
};

export type TableName = keyof TableMap;
