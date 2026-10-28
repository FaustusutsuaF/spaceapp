#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// 1.1.3 raised core and browser (998.7 / 1670.6 MiB measured): the current
// application adds production dependencies pdfjs-dist with @napi-rs/canvas
// (81 MiB, API PDF handling), typescript (23 MiB, peer of @t3-oss/env-core) and
// js-tiktoken (22 MiB, Space Gateway token counting).
// 1.1.5 raised core again: linux/arm64 measured 1066.9 MiB and linux/amd64 1045.0 MiB (sqlite3 in the image,
// the 1.1.5 application); the first public release run failed the arm64 build at 1050 MiB.
// 1.1.8 raised core to 1150 MiB for Python with sqlite3 (the Databases tool's SQLite worker): linux/amd64 measured
// 1090.6 MiB with python3 (rc3 without Python: 1057.9 MiB); the trimmed python3-minimal + libpython3-stdlib variant
// measured 1078.6 MiB, 21.4 MiB under the old 1100 MiB, and arm64 ran about 22 MiB above amd64 in 1.1.5.
// Issue #64 lowered the budgets after staging per-service runtime closures (deploy/docker/prepare-container-targets.mjs)
// and removing @opencode/cli's duplicate platform binary in the same RUN layer:
// - core: linux/amd64 measured 749.4 MiB (785,796,740 B) and linux/arm64 781.1 MiB (819,042,739 B) -> budget 830 MiB
// - browser: linux/amd64 measured 1085.8 MiB (1,138,549,184 B) and linux/arm64 1115.4 MiB (1,169,602,558 B) -> budget 1180 MiB
// - cli: linux/amd64 measured 638.2 MiB (669,226,218 B) and linux/arm64 669.9 MiB (702,410,611 B) -> budget 730 MiB
export const containerImageSizeBudgets = Object.freeze({
  core: 830 * mebibyte,
  browser: 1180 * mebibyte,
  cli: 730 * mebibyte
});

/**
 * Recorded uncompressed Docker image sizes in bytes for both supported target architectures (`linux/amd64` and `linux/arm64`).
 */
export const containerImageSizeMeasurements = Object.freeze({
  "linux/amd64": Object.freeze({
    core: 785796740,
    browser: 1138549184,
    cli: 669226218
  }),
  "linux/arm64": Object.freeze({
    core: 819042739,
    browser: 1169602558,
    cli: 702410611
  })
});

/**
 * Evaluate whether a container image's size in bytes fits within the configured budget for `target`.
 * @param {{ target: string, sizeBytes: number, budgets?: Record<string, number> }} options
 * @returns {{ target: string, sizeBytes: number, budgetBytes: number, remainingBytes: number, sizeFormatted: string, budgetFormatted: string, ok: boolean }}
 */
export function evaluateContainerImageSize({ target, sizeBytes, budgets = containerImageSizeBudgets }) {
  const budgetBytes = budgets[target];
  if (budgetBytes === undefined) {
    throw new Error(`Unknown container target: ${target}`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Invalid container image size: ${sizeBytes}`);
  }

  const remainingBytes = budgetBytes - sizeBytes;
  return {
    target,
    sizeBytes,
    budgetBytes,
    remainingBytes,
    sizeFormatted: formatMebibytes(sizeBytes),
    budgetFormatted: formatMebibytes(budgetBytes),
    ok: remainingBytes >= 0
  };
}

export const evaluateImageSize = evaluateContainerImageSize;

/**
 * Extract the value following `name` from a CLI argument array.
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Format a byte count as a human-readable MiB string with one decimal place.
 * @param {number} bytes
 * @returns {string}
 */
export function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

/**
 * Inspect the uncompressed size in bytes of a local Docker image tag.
 * @param {string} image
 * @returns {number}
 */
export function inspectContainerImageSize(image) {
  const output = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}", image],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  ).trim();
  return Number(output);
}

export const inspectDockerImageSize = inspectContainerImageSize;

/**
 * CLI entrypoint that inspects a local Docker image and enforces the target's size budget.
 * @param {string[]} [args]
 * @returns {{ target: string, sizeBytes: number, budgetBytes: number, remainingBytes: number, sizeFormatted: string, budgetFormatted: string, ok: boolean }}
 */
export function runContainerImageSizeBudget(args = process.argv.slice(2)) {
  const target = optionValue(args, "--target");
  const image = optionValue(args, "--image");
  if (!target || !image) {
    throw new Error(
      "Usage: container-image-size-budget.mjs --target <core|browser|cli> --image <name:tag>"
    );
  }

  const result = evaluateContainerImageSize({
    target,
    sizeBytes: inspectContainerImageSize(image)
  });
  const summary = [
    `${result.target} image ${image}: ${formatMebibytes(result.sizeBytes)}`,
    `budget ${formatMebibytes(result.budgetBytes)}`,
    `remaining ${formatMebibytes(result.remainingBytes)}`
  ].join("; ");
  if (!result.ok) {
    throw new Error(`Container image size budget exceeded: ${summary}`);
  }
  process.stdout.write(`${summary}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runContainerImageSizeBudget();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
