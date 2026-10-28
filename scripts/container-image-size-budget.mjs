import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// Per-service container target closures (Issue #64, measured linux/amd64):
// - core: ~742 MiB (was 1,004 MiB; budget 850.0 MiB) — API + web + worker + db migrations + runtime closure (node-pty decoupled, foreign-arch native binaries pruned)
// - browser: ~1,083 MiB (was 1,634 MiB; budget 1350.0 MiB) — Chromium + @space/browser-host + browser-host-main.js runtime closure only
// - cli: ~638 MiB (was 1,536 MiB; budget 1000.0 MiB) — @space/cli-host + node-pty + @opencode/cli@2.0.32 (with duplicate platform package pruned in-layer)
export const containerImageSizeBudgets = Object.freeze({
  core: 850 * mebibyte,
  browser: 1350 * mebibyte,
  cli: 1000 * mebibyte
});

/**
 * Format a byte count as a human-readable MiB string with one decimal place.
 * @param {number} bytes
 * @returns {string}
 */
export function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

/**
 * Evaluate whether an image's size in bytes fits within the configured budget for `target`.
 * @param {{ target: string, sizeBytes: number, budgets?: Record<string, number> }} options
 * @returns {{ ok: boolean, target: string, sizeBytes: number, budgetBytes: number, sizeFormatted: string, budgetFormatted: string }}
 */
export function evaluateImageSize({ target, sizeBytes, budgets = containerImageSizeBudgets }) {
  const budgetBytes = budgets[target];
  if (!Number.isInteger(budgetBytes) || budgetBytes <= 0) {
    throw new Error(`Unknown container image target "${target}".`);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Invalid container image size "${sizeBytes}".`);
  }

  return {
    ok: sizeBytes <= budgetBytes,
    target,
    sizeBytes,
    budgetBytes,
    sizeFormatted: formatMebibytes(sizeBytes),
    budgetFormatted: formatMebibytes(budgetBytes)
  };
}

/**
 * Inspect the uncompressed size in bytes of a local Docker image tag.
 * @param {string} image
 * @returns {number}
 */
export function inspectDockerImageSize(image) {
  const raw = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Size}}"], {
    encoding: "utf8"
  }).trim();
  const sizeBytes = Number.parseInt(raw, 10);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Docker reported an invalid image size for ${image}: ${raw}`);
  }
  return sizeBytes;
}

/**
 * Parse CLI flags (`--target` and `--image`) for `container-image-size-budget.mjs`.
 * @param {string[]} argv
 * @returns {{ target: string, image: string }}
 */
function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args.set(key.slice(2), argv[index + 1]);
    index += 1;
  }
  return {
    target: args.get("target") ?? "",
    image: args.get("image") ?? ""
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { target, image } = parseArgs(process.argv.slice(2));
  if (!target || !image) {
    throw new Error(
      "Usage: node scripts/container-image-size-budget.mjs --target <core|browser|cli> --image <tag>"
    );
  }

  const sizeBytes = inspectDockerImageSize(image);
  const result = evaluateImageSize({ target, sizeBytes });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `Container image ${image} (${result.sizeFormatted}) exceeds ${target} budget (${result.budgetFormatted}).\n`
    );
    process.exit(1);
  }
}
