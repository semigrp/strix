import { dirname, resolve } from "node:path";
import {
  snapshotProcedureArtifact,
  verifyProcedureArtifact,
  writeInputArtifact,
  writeOutputArtifact,
} from "./artifacts.js";
import type { BouroGateway } from "./adapters/bouro.js";
import { LocalProcessExecutor, type ProcessExecutor, type ProcessResult } from "./executor.js";
import {
  digestJson,
  contextBundleDigestPayload,
  nowIso,
  ref,
  resourceIdentity,
  type AttemptRecord,
  type BouroOutboxEntry,
  type ContextBundleV1,
  type GateResult,
  type GateSpec,
  type OuroStore,
  type PermissionTier,
  type PlanRecord,
  type ResourceRefV1,
  type RunRecord,
  type RunRequestV1,
  type TaskRecord,
} from "./schema.js";
import {
  JsonStoreRepository,
  appendEvent,
  eventRef,
  nextId,
  projectWork,
  validateStore,
} from "./store.js";
import { assertEvidenceCommand, assertPinnedRef, assertRunRequest } from "./validation.js";

export type EngineConfig = {
  repository: JsonStoreRepository;
  bouro: BouroGateway;
  executor?: ProcessExecutor;
  artifactRoot?: string;
  allowedPermissionTiers?: PermissionTier[];
};

export type FlushResult = {
  attempted: number;
  delivered: number;
  pending: number;
};

export class OuroEngine {
  readonly repository: JsonStoreRepository;
  readonly bouro: BouroGateway;
  readonly executor: ProcessExecutor;
  readonly artifactRoot: string;
  readonly allowedPermissionTiers: Set<PermissionTier>;

  constructor(config: EngineConfig) {
    this.repository = config.repository;
    this.bouro = config.bouro;
    this.executor = config.executor ?? new LocalProcessExecutor();
    this.artifactRoot = config.artifactRoot
      ? resolve(config.artifactRoot)
      : resolve(dirname(config.repository.path), "artifacts");
    this.allowedPermissionTiers = new Set(config.allowedPermissionTiers ?? ["inspect"]);
  }

  async run(value: unknown): Promise<RunRecord> {
    assertRunRequest(value);
    const request = value as RunRequestV1;
    if (!this.allowedPermissionTiers.has(request.procedure.permissionTier)) {
      throw new Error(
        `Permission tier is not allowed: ${request.procedure.permissionTier}. Explicitly allow it for this invocation.`,
      );
    }
    const verifiedArtifact = await verifyProcedureArtifact(
      request.workspace.path,
      request.procedure.artifact,
    );

    return this.repository.withWriterLock(async () => {
      const store = await this.repository.load();
      assertValidStore(store);
      const bundle = await this.bouro.queryContext(request.contextQuery);
      assertContextBundleMatches(bundle, request);

      const projected = projectWork(store, request.work);
      const workReference = ref("work", projected.revision.id, projected.revision.version);
      if (projected.created) {
        appendEvent(store, {
          type: "work_projected",
          subject: workReference,
          refs: [projected.revision.source],
          data: { status: projected.revision.status },
        });
      }

      const planId = nextId(store, "PLN");
      const taskId = nextId(store, "TSK");
      const runId = nextId(store, "RUN");
      const planReference = ref("plan", planId);
      const taskReference = ref("task", taskId);
      const runReference = ref("run", runId);
      const contextReference: ResourceRefV1 = {
        system: "bouro",
        type: "context_bundle",
        id: bundle.id,
        version: "1",
        digest: bundle.digest,
      };
      const executionArtifact = await snapshotProcedureArtifact(
        this.artifactRoot,
        runId,
        verifiedArtifact.path,
        verifiedArtifact.digest,
      );
      const inputArtifact = await writeInputArtifact(
        this.artifactRoot,
        runId,
        request.procedure.inputs,
      );
      const createdAt = nowIso();
      const plan: PlanRecord = {
        schema: "ouro.plan/v1",
        id: planId,
        version: "1",
        work: workReference,
        title: request.planTitle ?? `Execute ${request.work.title}`,
        status: "active",
        tasks: [taskReference],
        createdAt,
      };
      const task: TaskRecord = {
        schema: "ouro.task/v1",
        id: taskId,
        version: "1",
        plan: planReference,
        work: workReference,
        title: request.taskTitle ?? request.work.title,
        status: "pending",
        ...(request.procedure.definition ? { procedureDefinition: request.procedure.definition } : {}),
        createdAt,
      };
      const run: RunRecord = {
        schema: "ouro.run/v1",
        id: runId,
        version: "1",
        work: workReference,
        plan: planReference,
        task: taskReference,
        status: "pending",
        ...(request.experiment ? { experiment: request.experiment } : {}),
        contextBundle: contextReference,
        contextSnapshot: bundle,
        procedure: {
          ...(request.procedure.definition ? { definition: request.procedure.definition } : {}),
          artifact: request.procedure.artifact,
          executionArtifact: executionArtifact.ref,
          runtime: request.procedure.runtime,
          args: request.procedure.args ?? [],
          inputs: inputArtifact.ref,
          permissionTier: request.procedure.permissionTier,
          timeoutMs: request.procedure.timeoutMs ?? 300_000,
          retries: request.procedure.retries ?? 0,
          environment: {
            inherit: request.procedure.environment?.inherit ?? [],
            setNames: Object.keys(request.procedure.environment?.set ?? {}).sort(),
          },
          workspace: {
            ...request.workspace.ref,
            uri: request.workspace.ref.uri ?? resolve(request.workspace.path),
          },
        },
        createdAt,
        attempts: [],
        gates: [],
      };
      store.plans[planId] = plan;
      store.tasks[taskId] = task;
      store.runs[runId] = run;
      appendEvent(store, {
        type: "run_created",
        subject: runReference,
        refs: compactRefs([
          workReference,
          planReference,
          taskReference,
          request.experiment,
          request.procedure.definition,
          request.procedure.artifact,
          executionArtifact.ref,
          contextReference,
          request.workspace.ref,
          inputArtifact.ref,
        ]),
        data: { status: "pending", permissionTier: request.procedure.permissionTier },
      });
      await this.repository.save(store);

      const startedAt = nowIso();
      run.status = "running";
      run.startedAt = startedAt;
      task.status = "running";
      task.startedAt = startedAt;
      appendEvent(store, {
        type: "run_started",
        subject: runReference,
        refs: [workReference, taskReference, contextReference, executionArtifact.ref],
        data: { status: "running", permissionTier: request.procedure.permissionTier },
      });
      await this.repository.save(store);

      const gates = request.gates?.length
        ? request.gates
        : [{ id: "exit-zero", type: "exit_code", expected: 0 } satisfies GateSpec];
      let finalAttempt: AttemptRecord | undefined;
      let finalOutputs: ResourceRefV1[] = [];
      let succeeded = false;

      for (let attemptNumber = 1; attemptNumber <= run.procedure.retries + 1; attemptNumber += 1) {
        const attemptId = nextId(store, "ATT");
        const attemptReference = ref("attempt", attemptId);
        const attempt: AttemptRecord = {
          schema: "ouro.attempt/v1",
          id: attemptId,
          version: "1",
          run: runReference,
          number: attemptNumber,
          status: "running",
          startedAt: nowIso(),
        };
        store.attempts[attemptId] = attempt;
        run.attempts.push(attemptReference);
        appendEvent(store, {
          type: "attempt_started",
          subject: runReference,
          refs: [attemptReference, executionArtifact.ref, inputArtifact.ref],
          data: { status: "running", attempt: attemptNumber },
        });
        await this.repository.save(store);

        const processResult = await safelyExecute(this.executor, {
          runtime: run.procedure.runtime,
          artifactPath: executionArtifact.path,
          args: run.procedure.args,
          cwd: resolve(request.workspace.path),
          inputPath: inputArtifact.path,
          runId,
          attemptNumber,
          timeoutMs: run.procedure.timeoutMs,
          environment: request.procedure.environment ?? {},
        });
        const stdout = await writeOutputArtifact(
          this.artifactRoot,
          runId,
          attemptId,
          "stdout",
          processResult.stdout,
        );
        const stderr = await writeOutputArtifact(
          this.artifactRoot,
          runId,
          attemptId,
          "stderr",
          processResult.stderr,
        );
        const gateResults = gates.map((gate) =>
          evaluateGate(store, runReference, attemptReference, gate, processResult.exitCode),
        );
        const gatesPassed = gateResults.every((gate) => gate.status === "passed");
        const attemptSucceeded = !processResult.spawnError && !processResult.timedOut && gatesPassed;
        const completedAt = nowIso();
        attempt.status = processResult.timedOut
          ? "timed_out"
          : attemptSucceeded
            ? "succeeded"
            : "failed";
        attempt.completedAt = completedAt;
        attempt.durationMs = processResult.durationMs;
        attempt.exitCode = processResult.exitCode;
        attempt.signal = processResult.signal;
        attempt.timedOut = processResult.timedOut;
        attempt.stdout = stdout;
        attempt.stderr = stderr;
        attempt.stdoutTruncated = processResult.stdoutTruncated;
        attempt.stderrTruncated = processResult.stderrTruncated;
        if (processResult.spawnError) attempt.failureKind = "spawn_error";
        else if (processResult.timedOut) attempt.failureKind = "timeout";
        else if (!gatesPassed) attempt.failureKind = "gate_failed";
        finalAttempt = attempt;
        finalOutputs = [stdout, stderr];
        appendEvent(store, {
          type: "attempt_completed",
          subject: runReference,
          refs: [attemptReference, stdout, stderr],
          data: {
            status: attempt.status,
            attempt: attemptNumber,
            durationMs: processResult.durationMs,
            exitCode: processResult.exitCode,
            signal: processResult.signal,
            timedOut: processResult.timedOut,
            ...(attempt.failureKind ? { failureKind: attempt.failureKind } : {}),
          },
        });
        for (const gate of gateResults) {
          store.gates[gate.id] = gate;
          const gateReference = ref("gate_result", gate.id);
          run.gates.push(gateReference);
          appendEvent(store, {
            type: "gate_evaluated",
            subject: runReference,
            refs: [attemptReference, gateReference],
            data: {
              status: gate.status,
              attempt: attemptNumber,
              gateId: gate.gate.id,
              expected: gate.gate.expected,
              actual: gate.actual,
            },
          });
        }
        await this.repository.save(store);
        if (attemptSucceeded) {
          succeeded = true;
          break;
        }
      }

      if (!finalAttempt) throw new Error("Run produced no Attempt");
      const completedAt = nowIso();
      run.status = succeeded ? "succeeded" : "failed";
      run.completedAt = completedAt;
      task.status = succeeded ? "succeeded" : "failed";
      task.completedAt = completedAt;
      plan.status = succeeded ? "succeeded" : "failed";
      plan.completedAt = completedAt;
      const terminalEvent = appendEvent(store, {
        type: succeeded ? "run_succeeded" : "run_failed",
        subject: runReference,
        refs: [ref("attempt", finalAttempt.id), contextReference, request.procedure.artifact, ...finalOutputs],
        data: { status: run.status, attempt: finalAttempt.number },
      });
      run.result = {
        status: run.status,
        terminalEvent: eventRef(terminalEvent),
        attempt: ref("attempt", finalAttempt.id),
        outputs: finalOutputs,
      };
      if (shouldRegisterEvidence(request, succeeded)) {
        const commandId = nextId(store, "CMD");
        const entry: BouroOutboxEntry = {
          schema: "ouro.bouro-outbox/v1",
          id: commandId,
          command: {
            schema: "bouro.register-evidence/v1",
            source: "ouro",
            sourceEventId: terminalEvent.id,
            evidence: {
              title: request.evidence!.title,
              observation: request.evidence!.observation,
              observedAt: completedAt,
              generatedBy: runReference,
              derivedFrom: [
                contextReference,
                request.procedure.artifact,
                executionArtifact.ref,
                ...finalOutputs,
              ],
              ...(request.evidence!.assessments
                ? { assessments: request.evidence!.assessments }
                : {}),
            },
          },
          status: "pending",
          attempts: 0,
          createdAt: completedAt,
        };
        assertEvidenceCommand(entry.command);
        store.bouroOutbox[commandId] = entry;
      }
      await this.repository.save(store);
      await this.flushLocked(store);
      return structuredClone(run);
    });
  }

  async flushBouroOutbox(): Promise<FlushResult> {
    return this.repository.withWriterLock(async () => {
      const store = await this.repository.load();
      assertValidStore(store);
      return this.flushLocked(store);
    });
  }

  private async flushLocked(store: OuroStore): Promise<FlushResult> {
    let attempted = 0;
    let delivered = 0;
    for (const entry of Object.values(store.bouroOutbox).filter((item) => item.status === "pending")) {
      assertEvidenceCommand(entry.command);
      attempted += 1;
      entry.attempts += 1;
      entry.lastAttemptAt = nowIso();
      const runReference = entry.command.evidence.generatedBy;
      try {
        const evidence = await this.bouro.registerEvidence(entry.command);
        assertPinnedRef(evidence, "Registered Bouro Evidence");
        entry.status = "delivered";
        entry.deliveredAt = nowIso();
        entry.result = evidence;
        delete entry.lastError;
        appendEvent(store, {
          type: "evidence_delivery_succeeded",
          subject: runReference,
          refs: [evidence],
          data: { status: "delivered", replayed: entry.attempts > 1 },
        });
        delivered += 1;
      } catch (error) {
        entry.lastError = safeError(error);
        appendEvent(store, {
          type: "evidence_delivery_failed",
          subject: runReference,
          data: { status: "pending", replayed: entry.attempts > 1 },
        });
      }
      await this.repository.save(store);
    }
    return {
      attempted,
      delivered,
      pending: Object.values(store.bouroOutbox).filter((entry) => entry.status === "pending").length,
    };
  }
}

function assertContextBundleMatches(bundle: ContextBundleV1, request: RunRequestV1): void {
  if (bundle.schema !== "bouro.context-bundle/v1") throw new Error("Invalid Bouro ContextBundle schema");
  if (!Number.isFinite(Date.parse(bundle.createdAt))) throw new Error("ContextBundle has invalid createdAt");
  if (digestJson(contextBundleDigestPayload(bundle)) !== bundle.digest) {
    throw new Error("Bouro ContextBundle digest mismatch");
  }
  assertPinnedRef(bundle.ontology, "ContextBundle ontology", true);
  for (const selection of bundle.selections) {
    assertPinnedRef(selection.resource, `ContextBundle resource ${selection.resource.id}`);
  }
  for (const expected of request.contextQuery.roots) {
    const actual = bundle.query.roots.find(
      (candidate) => resourceIdentity(candidate) === resourceIdentity(expected),
    );
    if (!actual || actual.version !== expected.version) {
      throw new Error(`ContextBundle does not pin requested root ${expected.id}@${expected.version}`);
    }
  }
  if (bundle.query.purpose !== request.contextQuery.purpose) {
    throw new Error("ContextBundle purpose does not match the requested purpose");
  }
  for (const name of ["asOf", "tokenBudget", "maxResources"] as const) {
    const expected = request.contextQuery[name];
    if (expected !== undefined && bundle.query[name] !== expected) {
      throw new Error(`ContextBundle ${name} does not match the request`);
    }
  }
  for (const name of ["includeKinds", "allowedSensitivities"] as const) {
    const expected = request.contextQuery[name];
    if (expected && !sameStringSet(expected, bundle.query[name] ?? [])) {
      throw new Error(`ContextBundle ${name} does not match the request`);
    }
  }
}

function evaluateGate(
  store: OuroStore,
  run: ResourceRefV1,
  attempt: ResourceRefV1,
  gate: GateSpec,
  exitCode: number | null,
): GateResult {
  return {
    schema: "ouro.gate-result/v1",
    id: nextId(store, "GAT"),
    version: "1",
    run,
    attempt,
    gate,
    status: exitCode === gate.expected ? "passed" : "failed",
    actual: exitCode,
    evaluatedAt: nowIso(),
  };
}

function shouldRegisterEvidence(request: RunRequestV1, succeeded: boolean): boolean {
  if (!request.evidence) return false;
  return (request.evidence.when ?? "success") === "always" || succeeded;
}

async function safelyExecute(
  executor: ProcessExecutor,
  input: Parameters<ProcessExecutor["execute"]>[0],
): Promise<ProcessResult> {
  try {
    return await executor.execute(input);
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      spawnError: safeError(error),
    };
  }
}

function compactRefs(values: Array<ResourceRefV1 | undefined>): ResourceRefV1[] {
  return values.filter((value): value is ResourceRefV1 => Boolean(value));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\u0000") === [...new Set(right)].sort().join("\u0000");
}

function assertValidStore(store: OuroStore): void {
  const validation = validateStore(store);
  if (!validation.ok) throw new Error(`Invalid Ouro store: ${validation.errors.join("; ")}`);
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, " ").slice(0, 500);
}
