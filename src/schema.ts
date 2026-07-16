import { createHash } from "node:crypto";

export const STORE_SCHEMA = "ouro.store/v1" as const;
export const STORE_VERSION = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type ResourceRefV1 = {
  system: string;
  type: string;
  id: string;
  version?: string;
  uri?: string;
  digest?: `sha256:${string}`;
};

export type Sensitivity = "public" | "internal" | "restricted";
export type PermissionTier = "inspect" | "workspace-write" | "external-write";
export type Runtime = "node" | "direct";

export type ContextQueryV1 = {
  schema: "bouro.context-query/v1";
  roots: ResourceRefV1[];
  purpose: string;
  asOf?: string;
  tokenBudget?: number;
  maxResources?: number;
  includeKinds?: string[];
  allowedSensitivities?: Sensitivity[];
};

export type ContextSelection = {
  resource: ResourceRefV1;
  score: number;
  reasons: string[];
};

export type ContextBundleV1 = {
  schema: "bouro.context-bundle/v1";
  id: string;
  createdAt: string;
  ontology: ResourceRefV1;
  query: ContextQueryV1;
  selections: ContextSelection[];
  omitted: number;
  estimatedTokens: number;
  policyDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
};

export type EvidenceAssessment = {
  claim: ResourceRefV1;
  stance: "supports" | "contradicts" | "inconclusive";
  confidence?: number;
  rationale: string;
};

export type RegisterEvidenceCommandV1 = {
  schema: "bouro.register-evidence/v1";
  source: "ouro";
  sourceEventId: string;
  evidence: {
    title: string;
    observation: string;
    observedAt?: string;
    sensitivity?: Sensitivity;
    generatedBy: ResourceRefV1;
    derivedFrom: ResourceRefV1[];
    assessments?: EvidenceAssessment[];
  };
};

export type GateSpec = {
  id: string;
  type: "exit_code";
  expected: number;
};

export type EnvironmentSpec = {
  inherit?: string[];
  set?: Record<string, string>;
};

export type ProcedureBindingRequest = {
  definition?: ResourceRefV1;
  artifact: ResourceRefV1;
  runtime: Runtime;
  args?: string[];
  inputs: JsonObject;
  permissionTier: PermissionTier;
  timeoutMs?: number;
  retries?: number;
  environment?: EnvironmentSpec;
};

export type RunRequestV1 = {
  schema: "ouro.run-request/v1";
  work: {
    source: ResourceRefV1;
    title: string;
    status?: "open" | "closed";
  };
  planTitle?: string;
  taskTitle?: string;
  experiment?: ResourceRefV1;
  contextQuery: ContextQueryV1;
  procedure: ProcedureBindingRequest;
  workspace: {
    ref: ResourceRefV1;
    path: string;
  };
  gates?: GateSpec[];
  evidence?: {
    when?: "success" | "always";
    title: string;
    observation: string;
    assessments?: EvidenceAssessment[];
  };
};

export type WorkRevision = {
  schema: "ouro.work-revision/v1";
  id: string;
  version: string;
  source: ResourceRefV1;
  title: string;
  status: "open" | "closed";
  capturedAt: string;
  supersedes?: ResourceRefV1;
};

export type PlanRecord = {
  schema: "ouro.plan/v1";
  id: string;
  version: "1";
  work: ResourceRefV1;
  title: string;
  status: "active" | "succeeded" | "failed";
  tasks: ResourceRefV1[];
  createdAt: string;
  completedAt?: string;
};

export type TaskRecord = {
  schema: "ouro.task/v1";
  id: string;
  version: "1";
  plan: ResourceRefV1;
  work: ResourceRefV1;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed";
  procedureDefinition?: ResourceRefV1;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type ProcedureBinding = {
  definition?: ResourceRefV1;
  artifact: ResourceRefV1;
  executionArtifact: ResourceRefV1;
  runtime: Runtime;
  args: string[];
  inputs: ResourceRefV1;
  permissionTier: PermissionTier;
  timeoutMs: number;
  retries: number;
  environment: {
    inherit: string[];
    setNames: string[];
  };
  workspace: ResourceRefV1;
};

export type AttemptRecord = {
  schema: "ouro.attempt/v1";
  id: string;
  version: "1";
  run: ResourceRefV1;
  number: number;
  status: "running" | "succeeded" | "failed" | "timed_out";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  stdout?: ResourceRefV1;
  stderr?: ResourceRefV1;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  failureKind?: "spawn_error" | "timeout" | "gate_failed";
};

export type GateResult = {
  schema: "ouro.gate-result/v1";
  id: string;
  version: "1";
  run: ResourceRefV1;
  attempt: ResourceRefV1;
  gate: GateSpec;
  status: "passed" | "failed";
  actual: number | null;
  evaluatedAt: string;
};

export type RunResult = {
  status: "succeeded" | "failed";
  terminalEvent: ResourceRefV1;
  attempt: ResourceRefV1;
  outputs: ResourceRefV1[];
};

export type RunRecord = {
  schema: "ouro.run/v1";
  id: string;
  version: "1";
  work: ResourceRefV1;
  plan: ResourceRefV1;
  task: ResourceRefV1;
  status: "pending" | "running" | "succeeded" | "failed";
  experiment?: ResourceRefV1;
  contextBundle: ResourceRefV1;
  contextSnapshot: ContextBundleV1;
  procedure: ProcedureBinding;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  attempts: ResourceRefV1[];
  gates: ResourceRefV1[];
  result?: RunResult;
};

export type ExecutionEventType =
  | "work_projected"
  | "run_created"
  | "run_started"
  | "attempt_started"
  | "attempt_completed"
  | "gate_evaluated"
  | "run_succeeded"
  | "run_failed"
  | "evidence_delivery_succeeded"
  | "evidence_delivery_failed";

export type ExecutionEvent = {
  schema: "ouro.execution-event/v1";
  id: string;
  sequence: number;
  type: ExecutionEventType;
  occurredAt: string;
  subject: ResourceRefV1;
  refs: ResourceRefV1[];
  data: JsonObject;
  previousDigest?: `sha256:${string}`;
  digest: `sha256:${string}`;
};

export type BouroOutboxEntry = {
  schema: "ouro.bouro-outbox/v1";
  id: string;
  command: RegisterEvidenceCommandV1;
  status: "pending" | "delivered";
  attempts: number;
  createdAt: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  result?: ResourceRefV1;
  lastError?: string;
};

export type OuroStore = {
  schema: typeof STORE_SCHEMA;
  version: typeof STORE_VERSION;
  revision: number;
  createdAt: string;
  updatedAt: string;
  counters: Record<string, number>;
  workRevisions: Record<string, WorkRevision>;
  workHeads: Record<string, ResourceRefV1>;
  workSourceIndex: Record<string, string>;
  plans: Record<string, PlanRecord>;
  tasks: Record<string, TaskRecord>;
  runs: Record<string, RunRecord>;
  attempts: Record<string, AttemptRecord>;
  gates: Record<string, GateResult>;
  events: ExecutionEvent[];
  eventChainHead?: `sha256:${string}`;
  bouroOutbox: Record<string, BouroOutboxEntry>;
};

export type FukuroTelemetryEventV1 = {
  schema: "fukuro.telemetry-event/v1";
  source: "ouro";
  sourceEventId: string;
  occurredAt: string;
  kind: string;
  subject: ResourceRefV1;
  refs: ResourceRefV1[];
  data: JsonObject;
};

export function emptyStore(now = nowIso()): OuroStore {
  return {
    schema: STORE_SCHEMA,
    version: STORE_VERSION,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    counters: Object.fromEntries(
      ["WRK", "PLN", "TSK", "RUN", "ATT", "GAT", "EVT", "CMD"].map((prefix) => [prefix, 0]),
    ),
    workRevisions: {},
    workHeads: {},
    workSourceIndex: {},
    plans: {},
    tasks: {},
    runs: {},
    attempts: {},
    gates: {},
    events: [],
    bouroOutbox: {},
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function digestBytes(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestJson(value: unknown): `sha256:${string}` {
  return digestBytes(stableJson(value));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function ref(
  type: string,
  id: string,
  version = "1",
  extra: Pick<ResourceRefV1, "uri" | "digest"> = {},
): ResourceRefV1 {
  return { system: "ouro", type, id, version, ...extra };
}

export function resourceIdentity(value: ResourceRefV1): string {
  return `${value.system}\u0000${value.type}\u0000${value.id}`;
}

export function revisionKey(id: string, version: string): string {
  return `${id}@${version}`;
}

export function contextBundleDigestPayload(bundle: ContextBundleV1): {
  ontology: ResourceRefV1;
  query: ContextQueryV1;
  selections: ContextSelection[];
  omitted: number;
  estimatedTokens: number;
  policyDigest: `sha256:${string}`;
} {
  return {
    ontology: bundle.ontology,
    query: bundle.query,
    selections: bundle.selections,
    omitted: bundle.omitted,
    estimatedTokens: bundle.estimatedTokens,
    policyDigest: bundle.policyDigest,
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}
