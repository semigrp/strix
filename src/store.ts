import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  STORE_SCHEMA,
  STORE_VERSION,
  contextBundleDigestPayload,
  digestJson,
  emptyStore,
  nowIso,
  ref,
  resourceIdentity,
  revisionKey,
  stableJson,
  type ExecutionEvent,
  type ExecutionEventType,
  type JsonObject,
  type OuroStore,
  type ResourceRefV1,
  type WorkRevision,
} from "./schema.js";
import { assertNoSecretFields, assertPinnedRef } from "./validation.js";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export class JsonStoreRepository {
  readonly path: string;
  readonly lockPath: string;

  constructor(path: string) {
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
  }

  async load(): Promise<OuroStore> {
    return loadStore(this.path);
  }

  async save(store: OuroStore): Promise<void> {
    await saveStore(this.path, store);
  }

  async withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await this.acquireLock();
    try {
      return await fn();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }

  private async acquireLock(retried = false): Promise<FileHandle> {
    try {
      const handle = await open(this.lockPath, "wx");
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: nowIso() })}\n`,
        "utf8",
      );
      return handle;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const stale = await isStaleLock(this.lockPath);
      if (stale && !retried) {
        await rm(this.lockPath, { force: true });
        return this.acquireLock(true);
      }
      throw new Error(`Ouro writer lock is active: ${this.lockPath}`);
    }
  }
}

export function defaultStorePath(cwd: string): string {
  return resolve(cwd, ".ouro", "store.json");
}

export async function loadStore(path: string): Promise<OuroStore> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value) || value.schema !== STORE_SCHEMA || value.version !== STORE_VERSION) {
      throw new Error("Unsupported Ouro store schema or version");
    }
    return value as OuroStore;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

export async function saveStore(path: string, store: OuroStore): Promise<void> {
  const validation = validateStore(store);
  if (!validation.ok) throw new Error(`Refusing to save invalid Ouro store: ${validation.errors.join("; ")}`);
  store.revision += 1;
  store.updatedAt = nowIso();
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function nextId(store: OuroStore, prefix: string): string {
  store.counters[prefix] = (store.counters[prefix] ?? 0) + 1;
  const width = prefix === "EVT" ? 6 : 4;
  return `${prefix}-${String(store.counters[prefix]).padStart(width, "0")}`;
}

export function projectWork(
  store: OuroStore,
  input: { source: ResourceRefV1; title: string; status?: "open" | "closed" },
): { revision: WorkRevision; created: boolean } {
  const sourceKey = resourceIdentity(input.source);
  const existingId = store.workSourceIndex[sourceKey];
  const current = existingId ? getWorkHead(store, existingId) : undefined;
  const status = input.status ?? "open";
  if (
    current &&
    current.title === input.title &&
    current.status === status &&
    stableJson(current.source) === stableJson(input.source)
  ) {
    return { revision: current, created: false };
  }
  const id = existingId ?? nextId(store, "WRK");
  const version = current ? String(Number(current.version) + 1) : "1";
  const revision: WorkRevision = {
    schema: "ouro.work-revision/v1",
    id,
    version,
    source: input.source,
    title: input.title,
    status,
    capturedAt: nowIso(),
    ...(current ? { supersedes: ref("work", current.id, current.version) } : {}),
  };
  store.workRevisions[revisionKey(id, version)] = revision;
  store.workHeads[id] = ref("work", id, version);
  store.workSourceIndex[sourceKey] = id;
  return { revision, created: true };
}

export function getWorkHead(store: OuroStore, id: string): WorkRevision {
  const head = store.workHeads[id];
  if (!head?.version) throw new Error(`Work not found: ${id}`);
  const revision = store.workRevisions[revisionKey(id, head.version)];
  if (!revision) throw new Error(`Work revision not found: ${id}@${head.version}`);
  return revision;
}

export function appendEvent(
  store: OuroStore,
  input: {
    type: ExecutionEventType;
    subject: ResourceRefV1;
    refs?: ResourceRefV1[];
    data?: JsonObject;
    occurredAt?: string;
  },
): ExecutionEvent {
  const data = input.data ?? {};
  assertNoSecretFields(data, "executionEvent.data");
  const base = {
    schema: "ouro.execution-event/v1" as const,
    id: nextId(store, "EVT"),
    sequence: store.events.length + 1,
    type: input.type,
    occurredAt: input.occurredAt ?? nowIso(),
    subject: input.subject,
    refs: input.refs ?? [],
    data,
    ...(store.eventChainHead ? { previousDigest: store.eventChainHead } : {}),
  };
  const event: ExecutionEvent = { ...base, digest: digestJson(base) };
  store.events.push(event);
  store.eventChainHead = event.digest;
  return event;
}

export function eventRef(event: ExecutionEvent): ResourceRefV1 {
  return ref("execution_event", event.id, "1", { digest: event.digest });
}

export function validateStore(store: OuroStore): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw: unknown = store;
  if (!isRecord(raw)) return { ok: false, errors: ["Ouro store must be an object"], warnings };
  if (store.schema !== STORE_SCHEMA || store.version !== STORE_VERSION) {
    errors.push("Unsupported Ouro store schema or version");
  }
  if (!Number.isInteger(store.revision) || store.revision < 0) errors.push("Invalid store revision");
  for (const name of [
    "counters",
    "workRevisions",
    "workHeads",
    "workSourceIndex",
    "plans",
    "tasks",
    "runs",
    "attempts",
    "gates",
    "bouroOutbox",
  ]) {
    if (!isRecord(raw[name])) errors.push(`Store field ${name} must be an object`);
  }
  if (!Array.isArray(raw.events)) errors.push("Store field events must be an array");
  if (!Number.isFinite(Date.parse(String(raw.createdAt)))) errors.push("Invalid store createdAt");
  if (!Number.isFinite(Date.parse(String(raw.updatedAt)))) errors.push("Invalid store updatedAt");
  if (errors.length > 0) return { ok: false, errors, warnings };
  for (const validate of [validateWork, validateExecutionRecords, validateEventChain, validateOutbox]) {
    try {
      validate(store, errors);
    } catch (error) {
      errors.push(`Store validation failed safely: ${asMessage(error)}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function validateWork(store: OuroStore, errors: string[]): void {
  for (const [id, head] of Object.entries(store.workHeads)) {
    if (id !== head.id || !head.version) errors.push(`Invalid Work head: ${id}`);
    else if (!store.workRevisions[revisionKey(id, head.version)]) {
      errors.push(`Missing Work revision: ${id}@${head.version}`);
    }
  }
  for (const [key, work] of Object.entries(store.workRevisions)) {
    if (key !== revisionKey(work.id, work.version)) errors.push(`Invalid Work revision key: ${key}`);
    if (!work.title.trim()) errors.push(`${key} has an empty title`);
    if (Number(work.version) > 1 && !work.supersedes) errors.push(`${key} has no supersedes reference`);
  }
}

function validateExecutionRecords(store: OuroStore, errors: string[]): void {
  for (const plan of Object.values(store.plans)) {
    if (!store.workRevisions[revisionKey(plan.work.id, plan.work.version ?? "")]) {
      errors.push(`${plan.id} references missing Work`);
    }
    for (const task of plan.tasks) {
      if (!store.tasks[task.id]) errors.push(`${plan.id} references missing Task ${task.id}`);
    }
  }
  for (const task of Object.values(store.tasks)) {
    if (!store.plans[task.plan.id]) errors.push(`${task.id} references missing Plan ${task.plan.id}`);
  }
  for (const run of Object.values(store.runs)) {
    const plan = store.plans[run.plan.id];
    const task = store.tasks[run.task.id];
    if (!plan) errors.push(`${run.id} references missing Plan ${run.plan.id}`);
    if (!task) errors.push(`${run.id} references missing Task ${run.task.id}`);
    if (run.contextBundle.id !== run.contextSnapshot.id || run.contextBundle.digest !== run.contextSnapshot.digest) {
      errors.push(`${run.id} has a mismatched ContextBundle snapshot`);
    }
    if (digestJson(contextBundleDigestPayload(run.contextSnapshot)) !== run.contextSnapshot.digest) {
      errors.push(`${run.id} has an invalid ContextBundle snapshot digest`);
    }
    if (run.procedure.executionArtifact.digest !== run.procedure.artifact.digest) {
      errors.push(`${run.id} execution artifact differs from its ProcedureArtifact`);
    }
    try {
      assertPinnedRef(run.contextBundle, `${run.id} ContextBundle`, true);
      assertPinnedRef(run.procedure.artifact, `${run.id} ProcedureArtifact`, true);
      assertPinnedRef(run.procedure.executionArtifact, `${run.id} execution artifact`, true);
      assertPinnedRef(run.procedure.inputs, `${run.id} inputs`, true);
    } catch (error) {
      errors.push(asMessage(error));
    }
    for (const attempt of run.attempts) {
      if (!store.attempts[attempt.id]) errors.push(`${run.id} references missing Attempt ${attempt.id}`);
    }
    for (const gate of run.gates) {
      if (!store.gates[gate.id]) errors.push(`${run.id} references missing Gate ${gate.id}`);
    }
    if (["succeeded", "failed"].includes(run.status) && !run.result) {
      errors.push(`${run.id} is terminal without a result`);
    }
    if (["succeeded", "failed"].includes(run.status)) {
      if (plan?.status !== run.status) errors.push(`${run.id} and Plan status disagree`);
      if (task?.status !== run.status) errors.push(`${run.id} and Task status disagree`);
    }
    if (run.result) {
      const terminal = store.events.find((event) => event.id === run.result!.terminalEvent.id);
      if (!terminal) errors.push(`${run.id} references missing terminal event`);
      else {
        if (terminal.digest !== run.result.terminalEvent.digest) {
          errors.push(`${run.id} has a stale terminal event digest`);
        }
        const expectedType = run.status === "succeeded" ? "run_succeeded" : "run_failed";
        if (terminal.type !== expectedType) errors.push(`${run.id} terminal event type disagrees with status`);
      }
      if (!store.attempts[run.result.attempt.id]) errors.push(`${run.id} result references missing Attempt`);
    }
  }
  for (const attempt of Object.values(store.attempts)) {
    if (!store.runs[attempt.run.id]) errors.push(`${attempt.id} references missing Run ${attempt.run.id}`);
    if (attempt.status !== "running" && !attempt.completedAt) {
      errors.push(`${attempt.id} is terminal without completedAt`);
    }
  }
  for (const gate of Object.values(store.gates)) {
    if (!store.runs[gate.run.id]) errors.push(`${gate.id} references missing Run ${gate.run.id}`);
    if (!store.attempts[gate.attempt.id]) errors.push(`${gate.id} references missing Attempt ${gate.attempt.id}`);
  }
}

function validateEventChain(store: OuroStore, errors: string[]): void {
  let previous: `sha256:${string}` | undefined;
  const ids = new Set<string>();
  for (let index = 0; index < store.events.length; index += 1) {
    const rawEvent: unknown = store.events[index];
    if (!isRecord(rawEvent)) {
      errors.push(`Event at index ${index} must be an object`);
      continue;
    }
    const event = rawEvent as ExecutionEvent;
    if (ids.has(event.id)) errors.push(`Duplicate event id: ${event.id}`);
    ids.add(event.id);
    if (event.sequence !== index + 1) errors.push(`${event.id} has invalid sequence`);
    if (event.previousDigest !== previous) errors.push(`${event.id} breaks the event digest chain`);
    const { digest, ...payload } = event;
    if (digestJson(payload) !== digest) errors.push(`${event.id} has an invalid digest`);
    if (!Number.isFinite(Date.parse(event.occurredAt))) errors.push(`${event.id} has invalid occurredAt`);
    try {
      assertNoSecretFields(event.data, `${event.id}.data`);
    } catch (error) {
      errors.push(asMessage(error));
    }
    previous = event.digest;
  }
  if (store.eventChainHead !== previous) errors.push("Event chain head does not match the final event");
}

function validateOutbox(store: OuroStore, errors: string[]): void {
  const eventIds = new Set(store.events.map((event) => event.id));
  for (const [id, entry] of Object.entries(store.bouroOutbox)) {
    if (id !== entry.id) errors.push(`Bouro outbox key mismatch: ${id}`);
    if (!eventIds.has(entry.command.sourceEventId)) {
      errors.push(`${id} references missing source event ${entry.command.sourceEventId}`);
    }
    if (entry.command.source !== "ouro") errors.push(`${id} has invalid Evidence source`);
    if (entry.status === "delivered" && (!entry.deliveredAt || !entry.result)) {
      errors.push(`${id} is delivered without result metadata`);
    }
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(value.pid)) return true;
    try {
      process.kill(value.pid as number, 0);
      return false;
    } catch (error) {
      return isNodeError(error) && error.code === "ESRCH";
    }
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
