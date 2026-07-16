import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StaticBouroGateway } from "../src/adapters/bouro.js";
import { auditRunArtifacts } from "../src/artifacts.js";
import { exportFukuroNdjson } from "../src/adapters/fukuro.js";
import { runCli } from "../src/cli.js";
import { OuroEngine } from "../src/engine.js";
import {
  digestBytes,
  digestJson,
  type ContextBundleV1,
  type ContextQueryV1,
  type RunRequestV1,
} from "../src/schema.js";
import { JsonStoreRepository, validateStore } from "../src/store.js";
import { assertEvidenceCommand, assertRunRequest, assertTelemetryEvent } from "../src/validation.js";

test("receiver and producer contract fixtures validate", async () => {
  const contracts = fileURLToPath(new URL("../../contracts/", import.meta.url));
  const request = JSON.parse(
    await readFile(join(contracts, "fixtures", "run-request.valid.json"), "utf8"),
  ) as unknown;
  const telemetry = JSON.parse(
    await readFile(join(contracts, "fixtures", "fukuro-telemetry-event.valid.json"), "utf8"),
  ) as unknown;
  const evidence = JSON.parse(
    await readFile(join(contracts, "fixtures", "bouro-register-evidence.valid.json"), "utf8"),
  ) as unknown;
  assert.doesNotThrow(() => assertRunRequest(request));
  assert.doesNotThrow(() => assertTelemetryEvent(telemetry));
  assert.doesNotThrow(() => assertEvidenceCommand(evidence));
  const invalid = structuredClone(request) as RunRequestV1;
  invalid.procedure.inputs = { api_token: "must-not-be-stored" };
  assert.throws(() => assertRunRequest(invalid), /Secret-like field/);
  invalid.procedure.inputs = { apiToken: "must-not-be-stored" };
  assert.throws(() => assertRunRequest(invalid), /Secret-like field/);
});

test("golden path traces pinned inputs, gates, outputs, telemetry, and Evidence", async () => {
  const fixture = await createFixture({ procedure: successProcedure() });
  try {
    const run = await fixture.engine.run(fixture.request);
    assert.equal(run.status, "succeeded");
    assert.equal(run.attempts.length, 1);
    assert.equal(run.gates.length, 1);
    assert.equal(run.contextBundle.digest, fixture.gateway.bundle.digest);
    assert.equal(run.procedure.artifact.version, "fixture-commit");
    assert.equal(run.procedure.executionArtifact.digest, run.procedure.artifact.digest);
    assert.ok(run.result?.outputs.every((output) => output.digest));

    const store = await fixture.repository.load();
    assert.equal(validateStore(store).ok, true);
    assert.deepEqual(await auditRunArtifacts(store), []);
    assert.equal(store.plans[run.plan.id]?.status, "succeeded");
    assert.equal(store.tasks[run.task.id]?.status, "succeeded");
    assert.equal(fixture.gateway.evidenceCommands.length, 1);
    assert.equal(fixture.gateway.evidenceCommands[0]?.sourceEventId, run.result?.terminalEvent.id);
    assert.equal(Object.values(store.bouroOutbox)[0]?.status, "delivered");

    const first = exportFukuroNdjson(store, { runId: run.id });
    const second = exportFukuroNdjson(store, { runId: run.id });
    assert.equal(first, second);
    const events = parseNdjson(first);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.source === "ouro"));
    assert.ok(events.every((event) => !JSON.stringify(event).includes("uri")));
    assert.ok(events.every((event) => !JSON.stringify(event).includes("hello from test")));
    assert.equal(new Set(events.map((event) => event.sourceEventId)).size, events.length);

    const replay = await fixture.engine.flushBouroOutbox();
    assert.deepEqual(replay, { attempted: 0, delivered: 0, pending: 0 });
    assert.equal(fixture.gateway.evidenceCommands.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a failed first Attempt retries the same pinned ProcedureArtifact", async () => {
  const fixture = await createFixture({ procedure: retryProcedure(), retries: 1 });
  try {
    const run = await fixture.engine.run(fixture.request);
    assert.equal(run.status, "succeeded");
    assert.equal(run.attempts.length, 2);
    const store = await fixture.repository.load();
    assert.equal(store.attempts[run.attempts[0]!.id]?.status, "failed");
    assert.equal(store.attempts[run.attempts[1]!.id]?.status, "succeeded");
    assert.equal(
      store.events.filter((event) => event.type === "attempt_completed").length,
      2,
    );
    assert.equal(validateStore(store).ok, true);
  } finally {
    await fixture.cleanup();
  }
});

test("Fukuro and Bouro delivery outages never roll back a completed Run", async () => {
  const fixture = await createFixture({ procedure: successProcedure() });
  fixture.gateway.failEvidence = true;
  try {
    const run = await fixture.engine.run(fixture.request);
    assert.equal(run.status, "succeeded");
    let store = await fixture.repository.load();
    assert.equal(Object.values(store.bouroOutbox)[0]?.status, "pending");
    const exportedWhileOffline = exportFukuroNdjson(store, { runId: run.id });
    assert.ok(exportedWhileOffline.includes('"kind":"loop_end"'));

    fixture.gateway.failEvidence = false;
    const flushed = await fixture.engine.flushBouroOutbox();
    assert.deepEqual(flushed, { attempted: 1, delivered: 1, pending: 0 });
    store = await fixture.repository.load();
    assert.equal(Object.values(store.bouroOutbox)[0]?.status, "delivered");
    assert.equal(fixture.gateway.evidenceCommands.length, 2);
    assert.deepEqual(fixture.gateway.evidenceCommands[0], fixture.gateway.evidenceCommands[1]);
    assert.equal(validateStore(store).ok, true);
  } finally {
    await fixture.cleanup();
  }
});

test("timeout produces a failed Run and a timed-out Attempt", async () => {
  const fixture = await createFixture({ procedure: timeoutProcedure(), timeoutMs: 40 });
  try {
    const run = await fixture.engine.run(fixture.request);
    assert.equal(run.status, "failed");
    const store = await fixture.repository.load();
    const attempt = store.attempts[run.attempts[0]!.id];
    assert.equal(attempt?.status, "timed_out");
    assert.equal(attempt?.timedOut, true);
    assert.equal(attempt?.failureKind, "timeout");
    assert.equal(validateStore(store).ok, true);
  } finally {
    await fixture.cleanup();
  }
});

test("artifact digest mismatch fails before context query or Run creation", async () => {
  const fixture = await createFixture({ procedure: successProcedure() });
  fixture.request.procedure.artifact.digest = digestJson("wrong bytes");
  try {
    await assert.rejects(() => fixture.engine.run(fixture.request), /digest mismatch/);
    assert.equal(fixture.gateway.contextQueries.length, 0);
    const store = await fixture.repository.load();
    assert.equal(Object.keys(store.runs).length, 0);
    assert.equal(store.events.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("doctor validation detects event deletion and mutation", async () => {
  const fixture = await createFixture({ procedure: successProcedure() });
  try {
    await fixture.engine.run(fixture.request);
    const store = await fixture.repository.load();
    const modified = structuredClone(store);
    modified.events[1]!.data.status = "tampered";
    assert.equal(validateStore(modified).ok, false);
    assert.ok(validateStore(modified).errors.some((error) => error.includes("invalid digest")));
    const deleted = structuredClone(store);
    deleted.events.splice(1, 1);
    assert.equal(validateStore(deleted).ok, false);
    assert.ok(
      validateStore(deleted).errors.some(
        (error) => error.includes("invalid sequence") || error.includes("breaks the event digest chain"),
      ),
    );
    const contextTamper = structuredClone(store);
    const run = Object.values(contextTamper.runs)[0]!;
    run.contextSnapshot.query.purpose = "tampered purpose";
    assert.ok(
      validateStore(contextTamper).errors.some((error) =>
        error.includes("invalid ContextBundle snapshot digest"),
      ),
    );
    const projectionTamper = structuredClone(store);
    const projectionRun = Object.values(projectionTamper.runs)[0]!;
    projectionTamper.plans[projectionRun.plan.id]!.status = "failed";
    assert.ok(
      validateStore(projectionTamper).errors.some((error) => error.includes("Plan status disagree")),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("artifact audit detects modified run output bytes", async () => {
  const fixture = await createFixture({ procedure: successProcedure() });
  try {
    const run = await fixture.engine.run(fixture.request);
    const store = await fixture.repository.load();
    const stdout = store.attempts[run.attempts[0]!.id]?.stdout;
    assert.ok(stdout?.uri);
    await writeFile(stdout.uri, "tampered output\n", "utf8");
    const errors = await auditRunArtifacts(store);
    assert.ok(errors.some((error) => error.includes("artifact digest mismatch")));
  } finally {
    await fixture.cleanup();
  }
});

test("CLI demo is a complete CI-safe end-to-end fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ouro-cli-demo-"));
  const output: string[] = [];
  try {
    await runCli(["demo"], {
      cwd: directory,
      stdout: { write: (value) => output.push(value) },
      stderr: { write: () => {} },
    });
    const result = JSON.parse(output.join("")) as {
      ok: boolean;
      run: { id: string; status: string };
      telemetryEvents: number;
      evidenceCommands: number;
    };
    assert.equal(result.ok, true);
    assert.equal(result.run.status, "succeeded");
    assert.ok(result.telemetryEvents >= 6);
    assert.equal(result.evidenceCommands, 1);
    const repository = new JsonStoreRepository(join(directory, ".ouro", "store.json"));
    assert.equal(validateStore(await repository.load()).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor reports a structurally corrupt v1 store without crashing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ouro-corrupt-store-"));
  try {
    const path = join(directory, "store.json");
    await writeFile(
      path,
      JSON.stringify({ schema: "ouro.store/v1", version: 1, revision: 0 }),
      "utf8",
    );
    const bin = fileURLToPath(new URL("../bin/ouro.js", import.meta.url));
    const result = spawnSync(process.execPath, [bin, "doctor", "--store", path], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout) as { ok: boolean; validation: { errors: string[] } };
    assert.equal(output.ok, false);
    assert.ok(output.validation.errors.some((error) => error.includes("workRevisions")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

type Fixture = {
  directory: string;
  repository: JsonStoreRepository;
  gateway: StaticBouroGateway;
  engine: OuroEngine;
  request: RunRequestV1;
  cleanup(): Promise<void>;
};

async function createFixture(options: {
  procedure: string;
  retries?: number;
  timeoutMs?: number;
}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "ouro-engine-"));
  const workspace = join(directory, "workspace");
  await writeFile(join(directory, ".keep"), "", "utf8");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace, { recursive: true }));
  const procedurePath = join(workspace, "procedure.mjs");
  await writeFile(procedurePath, options.procedure, "utf8");
  const query = fixtureQuery();
  const bundle = fixtureBundle(query);
  const gateway = new StaticBouroGateway(bundle);
  const repository = new JsonStoreRepository(join(directory, ".ouro", "store.json"));
  const engine = new OuroEngine({ repository, bouro: gateway });
  const request: RunRequestV1 = {
    schema: "ouro.run-request/v1",
    work: {
      source: { system: "github", type: "issue", id: "semigrp/ouro#1", version: "fixture-v1" },
      title: "Execute fixture procedure",
    },
    experiment: query.roots[0]!,
    contextQuery: query,
    procedure: {
      definition: { system: "bouro", type: "procedure", id: "PROC-TEST", version: "1" },
      artifact: {
        system: "github",
        type: "file",
        id: "semigrp/ouro:test/procedure.mjs",
        version: "fixture-commit",
        uri: "procedure.mjs",
        digest: digestBytes(options.procedure),
      },
      runtime: "node",
      args: [],
      inputs: { message: "hello from test" },
      permissionTier: "inspect",
      timeoutMs: options.timeoutMs ?? 5_000,
      retries: options.retries ?? 0,
      environment: { inherit: ["PATH"] },
    },
    workspace: {
      ref: { system: "ouro", type: "workspace", id: "WS-TEST", version: "1" },
      path: workspace,
    },
    gates: [{ id: "exit-zero", type: "exit_code", expected: 0 }],
    evidence: {
      title: "Fixture completed",
      observation: "The fixture procedure passed its gate.",
    },
  };
  return {
    directory,
    repository,
    gateway,
    engine,
    request,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function fixtureQuery(): ContextQueryV1 {
  return {
    schema: "bouro.context-query/v1",
    roots: [{ system: "bouro", type: "experiment", id: "EXP-TEST", version: "1" }],
    purpose: "run the Ouro test fixture",
    tokenBudget: 2_000,
    maxResources: 10,
    allowedSensitivities: ["public", "internal"],
  };
}

function fixtureBundle(query: ContextQueryV1): ContextBundleV1 {
  const ontology = {
    system: "bouro",
    type: "ontology_release",
    id: "bouro-core",
    version: "1.0.0",
    digest: digestJson("fixture ontology"),
  } as const;
  const payload = {
    ontology,
    query,
    selections: [{ resource: query.roots[0]!, score: 100, reasons: ["query-root"] }],
    omitted: 0,
    estimatedTokens: 24,
    policyDigest: digestJson({ allowedSensitivities: query.allowedSensitivities, includeKinds: null }),
  };
  const digest = digestJson(payload);
  return {
    schema: "bouro.context-bundle/v1",
    id: `CTX-${digest.slice(7, 23).toUpperCase()}`,
    createdAt: "2026-07-14T00:00:00.000Z",
    ...payload,
    digest,
  };
}

function successProcedure(): string {
  return [
    'import { readFile } from "node:fs/promises";',
    'const input = JSON.parse(await readFile(process.env.OURO_INPUT_PATH, "utf8"));',
    'process.stdout.write(JSON.stringify({ ok: true, message: input.message }) + "\\n");',
    "",
  ].join("\n");
}

function retryProcedure(): string {
  return [
    'if (process.env.OURO_ATTEMPT === "1") process.exit(2);',
    'process.stdout.write("second attempt passed\\n");',
    "",
  ].join("\n");
}

function timeoutProcedure(): string {
  return 'setTimeout(() => process.stdout.write("too late\\n"), 1_000);\n';
}

function parseNdjson(value: string): Array<Record<string, unknown>> {
  return value
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
