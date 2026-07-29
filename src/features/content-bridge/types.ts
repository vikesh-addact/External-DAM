export type EnvironmentType = "source" | "destination";

export type TransferStatus =
  | "draft"
  | "ready"
  | "creating"
  | "queued"
  | "transferring"
  | "completed"
  | "failed";

export type MergeStrategy = "overwrite" | "merge" | "skipExisting";

export interface ContentEnvironment {
  id: string;
  name: string;
  project: string;
  region: string;
  type: "Production" | "Staging" | "Development";
  status: "Connected" | "Needs attention";
}

export interface ContentTreeItem {
  id: string;
  name: string;
  path: string;
  template: string;
  updatedAt: string;
  dependencies: string[];
  children?: ContentTreeItem[];
  hasMoreChildren?: boolean;
  siteId?: string;
}

export interface TransferRecord {
  id: string;
  name: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  selectedItemIds: string[];
  selectedItemDetails?: { id: string; name: string; path: string }[];
  strategy: MergeStrategy;
  status: TransferStatus;
  progress: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  contentTransferRequestId?: string;
  itemTransferJobId?: string;
  blobUrl?: string;
  failureReason?: string;
  chunkSetsMetadata?: Array<{ ChunkSetId: string; ChunkCount: number; TotalItemCount: number; IsMedia?: boolean }>;
  contentTransferFileName?: string;
  auditLog: AuditLogEntry[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  detail: string;
}

export interface TransferDraft {
  name: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  selectedItemIds: string[];
  selectedItemDetails?: { id: string; name: string; path: string }[];
  strategy: MergeStrategy;
}
