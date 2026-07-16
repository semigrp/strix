import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BouroCliGateway, StaticBouroGateway } from "./adapters/bouro.js";
import { auditRunArtifacts } from "./artifacts.js";
import { exportFukuroNdjson } from "./adapters/fukuro.js";
import { OuroEngine } from "./engine.js";
import {
  digestBytes,
  digestJson,
  type ContextBundleV1,
  type ContextQueryV1,
  type PermissionTier,
  type RunRequestV1,
} from "./schema.js";
import { JsonStoreRepository, defaultStorePath, validateStore } from "./store.js";

type Writer = { write(value: string): unknown };
export type CliIo = { cwd: string; stdout: Writer; stderr: Writer };
type OptionValue = string | string[] | boolean | undefined;
type Options = Record<string, OptionValue>;

export async function runCli(argv: string[], io: CliIo): Promise<void> {
  const command = argv[0] ?? "help";
  if (command === "events" && argv[1] === "export") {
    return eventsExport(parseArgs(argv.slice(2)), io);
  }
  if (command === "bouro" && argv[1] === "flush") {
    return bouroFlush(parseArgs(argv.slice(2)), io);
  }
  const options = parseArgs(argv.slice(1));
  switch (command) {
    case "init":
      return init(options, io);
    case "doctor":
      return doctor(options, io);
    case "status":
      return status(options, io);
    case "show":
      return show(options, io);
    case "run":
      return run(options, io);
    case "demo":
      return demo(options, io);
    case "help":
      return help(io);
    default:
      throw new Error(`Unknown command: ${command}\nRun ouro help.`);
  }
}

async function init(options: Options, io: CliIo): Promise<void> {
  const repository = repositoryFor(options, io);
  await repository.withWriterLock(async () => {
    const store = await repository.load();
    await repository.save(store);
  });
  writeJson(io.stdout, { ok: true, store: repository.path });
}

async function doctor(options: Options, io: CliIo): Promise<void> {
  const repository = repositoryFor(options, io);
  const store = await repository.load();
  const validation = validateStore(store);
  const artifactErrors = validation.ok ? await auditRunArtifacts(store) : [];
  const completeValidation = {
    ok: validation.ok && artifactErrors.length === 0,
    errors: [...validation.errors, ...artifactErrors],
    warnings: validation.warnings,
  };
  writeJson(io.stdout, {
    ok: completeValidation.ok,
    store: repository.path,
    validation: completeValidation,
    report: completeValidation.ok ? storeReport(store) : null,
  });
  if (!completeValidation.ok) process.exitCode = 1;
}

async function status(options: Options, io: CliIo): Promise<void> {
  const store = await repositoryFor(options, io).load();
  writeJson(io.stdout, storeReport(store));
}

async function show(options: Options, io: CliIo): Promise<void> {
  const id = requiredString(options.run, "run");
  const store = await repositoryFor(options, io).load();
  const runRecord = store.runs[id];
  if (!runRecord) throw new Error(`Run not found: ${id}`);
  writeJson(io.stdout, {
    run: runRecord,
    work: store.workRevisions[`${runRecord.work.id}@${runRecord.work.version}`],
    plan: store.plans[runRecord.plan.id],
    task: store.tasks[runRecord.task.id],
    attempts: runRecord.attempts.map((item) => store.attempts[item.id]),
    gates: runRecord.gates.map((item) => store.gates[item.id]),
    events: store.events.filter(
      (event) => event.subject.id === id || event.refs.some((reference) => reference.id === id),
    ),
    outbox: Object.values(store.bouroOutbox).filter(
      (entry) => entry.command.evidence.generatedBy.id === id,
    ),
  });
}

async function run(options: Options, io: CliIo): Promise<void> {
  const input = requiredString(options.spec, "spec");
  const request = JSON.parse(await readFile(resolve(io.cwd, input), "utf8")) as unknown;
  const engine = engineFor(options, io);
  const result = await engine.run(request);
  writeJson(io.stdout, { ok: result.status === "succeeded", run: result });
  if (result.status !== "succeeded") process.exitCode = 1;
}

async function bouroFlush(options: Options, io: CliIo): Promise<void> {
  const result = await engineFor(options, io).flushBouroOutbox();
  writeJson(io.stdout, { ok: result.pending === 0, ...result });
  if (result.pending > 0) process.exitCode = 1;
}

async function eventsExport(options: Options, io: CliIo): Promise<void> {
  const target = requiredString(options.target, "target");
  if (target !== "fukuro") throw new Error(`Unsupported event export target: ${target}`);
  const store = await repositoryFor(options, io).load();
  const sinceEventId = optionalString(options.since);
  const runId = optionalString(options.run);
  const ndjson = exportFukuroNdjson(store, {
    ...(sinceEventId ? { sinceEventId } : {}),
    ...(runId ? { runId } : {}),
  });
  const output = optionalString(options.out);
  if (output) {
    await writeFile(resolve(io.cwd, output), ndjson, "utf8");
    writeJson(io.stdout, { ok: true, output: resolve(io.cwd, output), events: countLines(ndjson) });
  } else {
    io.stdout.write(ndjson);
  }
}

async function demo(options: Options, io: CliIo): Promise<void> {
  const workspace = resolve(io.cwd, ".ouro", "demo-workspace");
  await mkdir(workspace, { recursive: true });
  const procedure = resolve(workspace, "procedure.mjs");
  const source = [
    'import { readFile } from "node:fs/promises";',
    'const input = JSON.parse(await readFile(process.env.OURO_INPUT_PATH, "utf8"));',
    'process.stdout.write(JSON.stringify({ ok: true, message: input.message }) + "\\n");',
    "",
  ].join("\n");
  await writeFile(procedure, source, "utf8");
  const query: ContextQueryV1 = {
    schema: "bouro.context-query/v1",
    roots: [{ system: "bouro", type: "experiment", id: "EXP-DEMO", version: "1" }],
    purpose: "execute the Ouro golden path",
    tokenBudget: 2_000,
    maxResources: 10,
    allowedSensitivities: ["public", "internal"],
  };
  const ontology = {
    system: "bouro",
    type: "ontology_release",
    id: "bouro-core",
    version: "1.0.0",
    digest: digestJson("ouro-demo-ontology"),
  } as const;
  const contextPayload = {
    ontology,
    query,
    selections: [{ resource: query.roots[0]!, score: 100, reasons: ["query-root"] }],
    omitted: 0,
    estimatedTokens: 32,
    policyDigest: digestJson({
      allowedSensitivities: query.allowedSensitivities,
      includeKinds: null,
    }),
  };
  const bundle: ContextBundleV1 = {
    schema: "bouro.context-bundle/v1",
    id: `CTX-${digestJson(contextPayload).slice(7, 23).toUpperCase()}`,
    createdAt: new Date().toISOString(),
    ...contextPayload,
    digest: digestJson(contextPayload),
  };
  const gateway = new StaticBouroGateway(bundle);
  const repository = repositoryFor(options, io);
  const engine = new OuroEngine({
    repository,
    bouro: gateway,
    allowedPermissionTiers: ["inspect"],
  });
  const request: RunRequestV1 = {
    schema: "ouro.run-request/v1",
    work: {
      source: { system: "github", type: "issue", id: "semigrp/ouro#demo", version: "1" },
      title: "Ouro golden path",
    },
    experiment: query.roots[0]!,
    contextQuery: query,
    procedure: {
      definition: { system: "bouro", type: "procedure", id: "PROC-DEMO", version: "1" },
      artifact: {
        system: "github",
        type: "file",
        id: "semigrp/ouro:demo/procedure.mjs",
        version: "demo-commit",
        uri: "procedure.mjs",
        digest: digestBytes(source),
      },
      runtime: "node",
      args: [],
      inputs: { message: "hello from Ouro" },
      permissionTier: "inspect",
      timeoutMs: 10_000,
      retries: 0,
      environment: { inherit: ["PATH"] },
    },
    workspace: {
      ref: { system: "ouro", type: "workspace", id: "WS-DEMO", version: "1" },
      path: workspace,
    },
    gates: [{ id: "exit-zero", type: "exit_code", expected: 0 }],
    evidence: {
      title: "Ouro golden path completed",
      observation: "The pinned procedure passed its execution gate.",
    },
  };
  const result = await engine.run(request);
  const store = await repository.load();
  writeJson(io.stdout, {
    ok: result.status === "succeeded",
    run: result,
    telemetryEvents: countLines(exportFukuroNdjson(store, { runId: result.id })),
    evidenceCommands: gateway.evidenceCommands.length,
  });
}

function engineFor(options: Options, io: CliIo): OuroEngine {
  const repository = repositoryFor(options, io);
  const gateway = new BouroCliGateway({
    bin: optionalString(options["bouro-bin"]) ?? process.env.BOURO_BIN ?? "bouro",
    ...(optionalString(options["bouro-vault"])
      ? { vault: resolve(io.cwd, optionalString(options["bouro-vault"])!) }
      : process.env.BOURO_VAULT
        ? { vault: process.env.BOURO_VAULT }
        : {}),
  });
  return new OuroEngine({
    repository,
    bouro: gateway,
    ...(optionalString(options["artifact-root"])
      ? { artifactRoot: resolve(io.cwd, optionalString(options["artifact-root"])!) }
      : {}),
    allowedPermissionTiers: allowedTiers(options),
  });
}

function repositoryFor(options: Options, io: CliIo): JsonStoreRepository {
  return new JsonStoreRepository(
    optionalString(options.store)
      ? resolve(io.cwd, optionalString(options.store)!)
      : defaultStorePath(io.cwd),
  );
}

function allowedTiers(options: Options): PermissionTier[] {
  const values = stringList(options["allow-tier"]);
  const tiers = new Set<PermissionTier>(["inspect"]);
  for (const value of values) {
    if (!["inspect", "workspace-write", "external-write"].includes(value)) {
      throw new Error(`Invalid permission tier: ${value}`);
    }
    tiers.add(value as PermissionTier);
  }
  return [...tiers];
}

function storeReport(store: Awaited<ReturnType<JsonStoreRepository["load"]>>): object {
  return {
    schema: store.schema,
    revision: store.revision,
    works: Object.keys(store.workHeads).length,
    plans: Object.keys(store.plans).length,
    tasks: Object.keys(store.tasks).length,
    runs: {
      total: Object.keys(store.runs).length,
      pending: Object.values(store.runs).filter((runRecord) => runRecord.status === "pending").length,
      running: Object.values(store.runs).filter((runRecord) => runRecord.status === "running").length,
      succeeded: Object.values(store.runs).filter((runRecord) => runRecord.status === "succeeded").length,
      failed: Object.values(store.runs).filter((runRecord) => runRecord.status === "failed").length,
    },
    attempts: Object.keys(store.attempts).length,
    gates: Object.keys(store.gates).length,
    events: store.events.length,
    eventChainHead: store.eventChainHead ?? null,
    bouroOutbox: {
      pending: Object.values(store.bouroOutbox).filter((entry) => entry.status === "pending").length,
      delivered: Object.values(store.bouroOutbox).filter((entry) => entry.status === "delivered").length,
    },
  };
}

function parseArgs(argv: string[]): Options {
  const result: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = true;
      continue;
    }
    index += 1;
    const current = result[key];
    if (typeof current === "string") result[key] = [current, value];
    else if (Array.isArray(current)) current.push(value);
    else result[key] = value;
  }
  return result;
}

function requiredString(value: OptionValue, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`--${name} is required`);
  return result;
}

function optionalString(value: OptionValue): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.at(-1);
  return undefined;
}

function stringList(value: OptionValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function countLines(value: string): number {
  return value === "" ? 0 : value.trimEnd().split("\n").length;
}

function writeJson(writer: Writer, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(io: CliIo): void {
  io.stdout.write(`${basename(process.argv[1] ?? "ouro")} commands:

  init [--store <path>]
  doctor | status [--store <path>]
  run --spec <ouro.run-request/v1.json> [--allow-tier <tier>]
      [--bouro-bin <path>] [--bouro-vault <path>] [--store <path>]
  show --run <RUN-id> [--store <path>]
  events export --target fukuro [--since <EVT-id>] [--run <RUN-id>] [--out <path>]
  bouro flush [--bouro-bin <path>] [--bouro-vault <path>] [--store <path>]
  demo [--store <path>]

Permission tiers:
  inspect (allowed by default), workspace-write, external-write

Environment:
  BOURO_BIN, BOURO_VAULT
`);
}
