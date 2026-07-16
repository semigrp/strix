import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BouroCliGateway } from "../src/adapters/bouro.js";
import { exportFukuroNdjson } from "../src/adapters/fukuro.js";
import { OuroEngine } from "../src/engine.js";
import { digestBytes, type RunRequestV1 } from "../src/schema.js";
import { JsonStoreRepository, validateStore } from "../src/store.js";

const bouroRoot = process.env.BOURO_ROOT;

test(
  "real Bouro CLI completes Context query, Ouro Run, Evidence registration, and replay",
  { skip: bouroRoot ? false : "Set BOURO_ROOT to run the cross-repository fixture" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ouro-bouro-cross-repo-"));
    try {
      const bouroBin = join(bouroRoot!, "dist", "bin", "bouro.js");
      const bouroVault = join(directory, "bouro-store.json");
      const demo = invokeBouro(bouroBin, ["demo", "--vault", bouroVault]);
      assert.equal(demo.status, 0, demo.stderr);
      assertContractSnapshots(bouroRoot!);

      const workspace = join(directory, "workspace");
      await mkdir(workspace, { recursive: true });
      const source = [
        'import { readFile } from "node:fs/promises";',
        'const input = JSON.parse(await readFile(process.env.OURO_INPUT_PATH, "utf8"));',
        'process.stdout.write(JSON.stringify({ ok: true, input }) + "\\n");',
        "",
      ].join("\n");
      await writeFile(join(workspace, "procedure.mjs"), source, "utf8");
      const request: RunRequestV1 = {
        schema: "ouro.run-request/v1",
        work: {
          source: { system: "github", type: "issue", id: "semigrp/ouro#e2e", version: "1" },
          title: "Cross-repository verification",
        },
        experiment: { system: "bouro", type: "experiment", id: "EXP-0001", version: "1" },
        contextQuery: {
          schema: "bouro.context-query/v1",
          roots: [{ system: "bouro", type: "experiment", id: "EXP-0001", version: "1" }],
          purpose: "run the Ouro cross-repository fixture",
          tokenBudget: 4_000,
          maxResources: 30,
          allowedSensitivities: ["public", "internal"],
        },
        procedure: {
          definition: { system: "bouro", type: "procedure", id: "PROC-0001", version: "1" },
          artifact: {
            system: "github",
            type: "file",
            id: "semigrp/ouro:e2e/procedure.mjs",
            version: "fixture-commit",
            uri: "procedure.mjs",
            digest: digestBytes(source),
          },
          runtime: "node",
          args: [],
          inputs: { message: "real Bouro integration" },
          permissionTier: "inspect",
          timeoutMs: 10_000,
          retries: 0,
          environment: { inherit: ["PATH"] },
        },
        workspace: {
          ref: { system: "ouro", type: "workspace", id: "WS-E2E", version: "1" },
          path: workspace,
        },
        gates: [{ id: "exit-zero", type: "exit_code", expected: 0 }],
        evidence: {
          title: "Cross-repository Run completed",
          observation: "The pinned ContextBundle and ProcedureArtifact passed the Gate.",
        },
      };
      const repository = new JsonStoreRepository(join(directory, "ouro-store.json"));
      const gateway = new BouroCliGateway({ bin: bouroBin, vault: bouroVault });
      const engine = new OuroEngine({ repository, bouro: gateway });
      const run = await engine.run(request);
      assert.equal(run.status, "succeeded");

      const store = await repository.load();
      assert.equal(validateStore(store).ok, true);
      const outbox = Object.values(store.bouroOutbox)[0]!;
      assert.equal(outbox.status, "delivered");
      assert.equal(outbox.result?.id, "EVD-0002");
      const firstExport = exportFukuroNdjson(store, { runId: run.id });
      const secondExport = exportFukuroNdjson(store, { runId: run.id });
      assert.equal(firstExport, secondExport);

      const show = invokeBouro(bouroBin, ["show", "--id", "EVD-0002", "--vault", bouroVault]);
      assert.equal(show.status, 0, show.stderr);
      const evidence = JSON.parse(show.stdout) as {
        revision: { provenance: { generatedBy?: { id?: string }; derivedFrom: Array<{ id?: string }> } };
      };
      assert.equal(evidence.revision.provenance.generatedBy?.id, run.id);
      assert.ok(evidence.revision.provenance.derivedFrom.some((reference) => reference.id === run.contextBundle.id));

      const commandPath = join(directory, "evidence-command.json");
      await writeFile(commandPath, `${JSON.stringify(outbox.command, null, 2)}\n`, "utf8");
      const replay = invokeBouro(bouroBin, [
        "evidence",
        "register",
        "--input",
        commandPath,
        "--vault",
        bouroVault,
      ]);
      assert.equal(replay.status, 0, replay.stderr);
      const replayed = JSON.parse(replay.stdout) as { result: { replayed: boolean; evidence: { id: string } } };
      assert.equal(replayed.result.replayed, true);
      assert.equal(replayed.result.evidence.id, "EVD-0002");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function invokeBouro(bin: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
}

function assertContractSnapshots(root: string): void {
  const ouroContracts = fileURLToPath(new URL("../../contracts/", import.meta.url));
  const pairs = [
    ["resource-ref.v1.schema.json", "resource-ref.v1.schema.json"],
    ["bouro-context-query.v1.schema.json", "context-query.v1.schema.json"],
    ["bouro-register-evidence.v1.schema.json", "register-evidence.v1.schema.json"],
  ] as const;
  for (const [ouroName, bouroName] of pairs) {
    const ouro = normalizedContract(readJson(join(ouroContracts, ouroName)));
    const bouro = normalizedContract(readJson(join(root, "contracts", bouroName)));
    assert.deepEqual(ouro, bouro, `${ouroName} drifted from Bouro receiver contract`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function normalizedContract(value: unknown): unknown {
  const contract = structuredClone(value) as Record<string, unknown>;
  delete contract.$id;
  delete contract.title;
  return rewriteRefs(contract);
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "$ref" && typeof item === "string" ? item.replace(/^.*resource-ref/, "resource-ref") : rewriteRefs(item),
    ]),
  );
}
