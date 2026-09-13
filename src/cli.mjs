// Minimal CLI plumbing shared by the three workflow CLIs: flag parsing, atomic 0600 JSON files and
// a single JSON result on stdout with a non-zero exit code for refused steps.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { saveRecoveryBundle } from "./recovery.mjs";

export function parseArgs(argv, commands) {
  const [command, ...rest] = argv;
  if (!command || !commands.includes(command)) {
    throw Object.assign(new Error(`Usage: <script> ${commands.join("|")} [flags]`), { code: "USAGE" });
  }
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw Object.assign(new Error(`Unexpected argument ${token}`), { code: "USAGE" });
    const [name, inline] = token.slice(2).split("=");
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return { command, flags };
}

export function requiredFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error(`--${name} is required`), { code: "USAGE", field: name });
  }
  return value;
}

export function integerFlag(flags, name, fallback) {
  if (flags[name] === undefined) {
    if (fallback === undefined) throw Object.assign(new Error(`--${name} is required`), { code: "USAGE", field: name });
    return fallback;
  }
  const value = Number(flags[name]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error(`--${name} must be a non-negative integer`), { code: "USAGE", field: name });
  }
  return value;
}

export function bigintFlag(flags, name, fallback) {
  const raw = flags[name] ?? fallback;
  if (raw === undefined) throw Object.assign(new Error(`--${name} is required`), { code: "USAGE", field: name });
  if (!/^[1-9][0-9]{0,77}$/.test(String(raw))) {
    throw Object.assign(new Error(`--${name} must be a positive integer in minor units`), { code: "USAGE", field: name });
  }
  return BigInt(raw);
}

export function workflowPaths(directory) {
  return {
    directory,
    order: join(directory, "order.json"),
    checkpoint: join(directory, "checkpoint.json"),
    recipientKey: join(directory, "recipient-key.json"),
    submission: join(directory, "provider-submission.json"),
    bundle: join(directory, "bundle.json"),
    verifiedSubmission: join(directory, "verified-submission.json"),
    workflow: join(directory, "workflow.json"),
    recovery: join(directory, "recovery.json"),
  };
}

export async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`${label} is not readable at ${path}: ${error.message}`), { code: "MISSING_FILE", path });
  }
}

export async function writeJson(path, value) {
  await saveRecoveryBundle(path, value);
  return path;
}

export async function fileMode(path) {
  return (await stat(path)).mode & 0o777;
}

export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function recordStep(workflowPath, entry) {
  let workflow = { schemaVersion: 1, steps: [] };
  try {
    workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    if (!Array.isArray(workflow.steps)) workflow.steps = [];
  } catch {
    // The first step creates the file.
  }
  workflow.steps.push({ at: new Date().toISOString(), ...entry });
  await writeJson(workflowPath, workflow);
  return workflow;
}

/// Runs one CLI step, prints exactly one JSON object and sets a non-zero exit code on refusal.
export async function runCli(step, handler) {
  let result;
  try {
    result = await handler();
  } catch (error) {
    result = {
      ok: false,
      step,
      code: error?.code ?? "CLI_ERROR",
      message: error?.shortMessage ?? error?.message ?? String(error),
    };
  }
  console.log(JSON.stringify(result, null, 2));
  if (result?.ok !== true) process.exitCode = 1;
  return result;
}
