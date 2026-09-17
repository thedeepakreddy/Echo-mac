/** Shared memory contracts. All durable values are data, never executable instructions. */
export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "tool";
export type MemoryStatus = "candidate" | "active" | "disputed" | "superseded" | "expired" | "deleted";
export type ExecutionOrigin = "real" | "rehearsal" | "replay" | "test";
export interface MemoryScope {
  principalId?: string;
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  resourceIds?: string[];
  allowedActors?: string[];
}
export interface MemorySource {
  kind: "user" | "tool" | "document" | "inference" | "import";
  actorId?: string;
  taskId?: string;
  runId?: string;
  turnId?: string;
  callId?: string;
  origin: ExecutionOrigin;
  evidenceRefs: string[];
  derivedFromIds: string[];
  trust: "user_asserted" | "observed" | "external" | "inferred" | "legacy_unknown";
  modelOrToolVersion?: string;
}
export interface MemoryPrivacy {
  sensitivity: "ordinary" | "personal" | "sensitive";
  modelAccess: "local_only" | "configured_providers";
  retentionPolicy: string;
  trainingAllowed: boolean;
}
export interface MemoryObject {
  schemaVersion: 1;
  id: string;
  revision: number;
  layer: MemoryLayer;
  kind: string;
  key?: string;
  summary: string;
  payload?: Record<string, unknown>;
  payloadRef?: string;
  confidence: number | null;
  confidenceBasis: string;
  importance: number;
  status: MemoryStatus;
  scope: MemoryScope;
  source: MemorySource;
  createdAt: string;
  observedAt: string | null;
  validFrom?: string;
  validTo?: string;
  lastVerifiedAt?: string;
  expiresAt?: string;
  timezone?: string;
  supersedesIds: string[];
  contradictsIds: string[];
  privacy: MemoryPrivacy;
  /** Disposable, local index only; vectors never confer truth or authority. */
  embedding?: { model: string; dimensions: number; contentHash: string; values: number[] };
}
export type MemoryInput = Pick<MemoryObject, "layer" | "kind" | "summary"> &
  Partial<Omit<MemoryObject, "schemaVersion" | "revision" | "layer" | "kind" | "summary" | "source" | "privacy">> & {
    source?: Partial<MemorySource>;
    privacy?: Partial<MemoryPrivacy>;
    expectedRevision?: number;
    /** The read revision used by an asynchronous producer; protects deletion races. */
    baseRevision?: number;
  };
export interface MemoryFilters {
  layer?: MemoryLayer;
  kind?: string;
  status?: MemoryStatus;
  taskId?: string;
  query?: string;
  includeInactive?: boolean;
}
export interface SuppressionRule {
  id: string;
  scope: MemoryScope;
  taskId?: string;
  enabled: boolean;
  reason?: string;
  createdAt: string;
}
export interface MemoryChange {
  type: "write" | "delete" | "suppression" | "import";
  revision: number;
  ids: string[];
}
export interface ForgetRequest {
  ids?: string[];
  query?: string;
  scope?: MemoryScope;
  taskId?: string;
}
export interface ForgetReceipt {
  deletedIds: string[];
  count: number;
  revision: number;
  /** Transient adapter input. Never persisted in the receipt or emitted as logs. */
  deletedObjects: MemoryObject[];
}
