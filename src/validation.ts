import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type {
  FukuroTelemetryEventV1,
  JsonValue,
  ResourceRefV1,
  RegisterEvidenceCommandV1,
  RunRequestV1,
} from "./schema.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options: unknown) => {
  addSchema(schema: unknown): void;
  compile(schema: unknown): Validator;
};
const addFormats = require("ajv-formats").default as (ajv: object) => void;

type Validator = ((value: unknown) => boolean) & { errors?: unknown };

const contractRoot = fileURLToPath(new URL("../../contracts/", import.meta.url));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const resourceRefSchema = readContract("resource-ref.v1.schema.json");
const contextQuerySchema = readContract("bouro-context-query.v1.schema.json");
ajv.addSchema(resourceRefSchema);
ajv.addSchema(contextQuerySchema);
const validateRunContract = ajv.compile(readContract("run-request.v1.schema.json"));
const validateTelemetryContract = ajv.compile(readContract("fukuro-telemetry-event.v1.schema.json"));
const validateEvidenceContract = ajv.compile(readContract("bouro-register-evidence.v1.schema.json"));

const SECRET_KEY = /(^|[_-])(authorization|credential|password|secret|token|api_?key|private_?key)($|[_-])/i;

export function assertRunRequest(value: unknown): asserts value is RunRequestV1 {
  if (!validateRunContract(value)) {
    throw new Error(`Invalid ouro.run-request/v1: ${JSON.stringify(validateRunContract.errors)}`);
  }
  const request = value as RunRequestV1;
  if (request.experiment) assertOwnedPinnedRef(request.experiment, "bouro", "experiment");
  for (const root of request.contextQuery.roots) assertPinnedRef(root, "Context query root");
  if (request.procedure.definition) {
    assertOwnedPinnedRef(request.procedure.definition, "bouro", "procedure");
  }
  assertPinnedRef(request.procedure.artifact, "Procedure artifact", true);
  if (!request.procedure.artifact.uri) throw new Error("Procedure artifact needs a URI");
  assertOwnedPinnedRef(request.workspace.ref, "ouro", "workspace");
  assertNoSecretFields(request.procedure.inputs, "procedure.inputs");
  for (const name of request.procedure.environment?.inherit ?? []) assertSafeEnvironmentName(name);
  for (const [name] of Object.entries(request.procedure.environment?.set ?? {})) {
    assertSafeEnvironmentName(name);
  }
  for (const assessment of request.evidence?.assessments ?? []) {
    assertOwnedPinnedRef(assessment.claim, "bouro", "claim");
  }
}

export function assertTelemetryEvent(value: unknown): asserts value is FukuroTelemetryEventV1 {
  if (!validateTelemetryContract(value)) {
    throw new Error(
      `Invalid fukuro.telemetry-event/v1: ${JSON.stringify(validateTelemetryContract.errors)}`,
    );
  }
  assertNoSecretFields((value as FukuroTelemetryEventV1).data, "telemetry.data");
}

export function assertEvidenceCommand(value: unknown): asserts value is RegisterEvidenceCommandV1 {
  if (!validateEvidenceContract(value)) {
    throw new Error(
      `Invalid bouro.register-evidence/v1: ${JSON.stringify(validateEvidenceContract.errors)}`,
    );
  }
  const command = value as RegisterEvidenceCommandV1;
  assertPinnedRef(command.evidence.generatedBy, "Evidence generatedBy");
  for (const reference of command.evidence.derivedFrom) {
    assertPinnedRef(reference, `Evidence derivedFrom ${reference.id}`);
  }
}

export function assertPinnedRef(value: ResourceRefV1, label: string, requireDigest = false): void {
  if (!value.version && !value.digest) throw new Error(`${label} must pin version or digest`);
  if (requireDigest && !value.digest) throw new Error(`${label} must pin a SHA-256 digest`);
  if (value.digest && !/^sha256:[a-fA-F0-9]{64}$/.test(value.digest)) {
    throw new Error(`${label} has an invalid SHA-256 digest`);
  }
}

export function assertNoSecretFields(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (isSecretName(key)) throw new Error(`Secret-like field is not allowed at ${path}.${key}`);
    assertNoSecretFields(item, `${path}.${key}`);
  }
}

function assertOwnedPinnedRef(value: ResourceRefV1, system: string, type: string): void {
  if (value.system !== system || value.type !== type) {
    throw new Error(`Expected ${system}:${type} reference, got ${value.system}:${value.type}`);
  }
  assertPinnedRef(value, `${system}:${type}`);
}

function assertSafeEnvironmentName(name: string): void {
  if (isSecretName(name)) {
    throw new Error(`Secret-like environment variable is not allowed in RunSpec: ${name}`);
  }
}

function isSecretName(name: string): boolean {
  const segmented = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SECRET_KEY.test(segmented);
}

function readContract(name: string): unknown {
  return JSON.parse(readFileSync(`${contractRoot}${name}`, "utf8")) as unknown;
}
