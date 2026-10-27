export type ClientType = "architect" | "fabricator" | "contractor" | "owner" | "developer";

export type FeeType = "Lump Sum" | "Not To Exceed" | "Hourly" | "Time & Materials";

export interface Address {
  street: string;
  unit?: string | null;
  city: string;
  state: string;
  zip: string;
  county: string;
}

export interface Contact {
  name: string;
  title?: string | null;
  email: string;
  phone: string;
  address?: Address | null;
}

export interface Client {
  client_id: string;
  entity: string;
  type: ClientType;
  address: Address;
  contacts: Contact[];
  billing_contact_index: number;
  default_terms_days: number;
  referral_source: string;
  first_job?: string;
  notes?: string;
}

export interface Project {
  project_id: string;
  client_id: string;
  client_status: "existing" | "new";
  location: Address;
  structural_material: string[];
  scope: string;
  deliverables: string[];
  fee_type: FeeType;
  notes?: string;
}

export interface Deadline {
  deadline_id: string;
  project_id: string;
  name: string;
  due_date?: string;
  notes?: string;
  status: "upcoming" | "complete" | "overdue";
}

export type TableMap = {
  "clients.json": Client;
  "projects.json": Project;
  "deadlines.json": Deadline;
};

export type TableName = keyof TableMap;
