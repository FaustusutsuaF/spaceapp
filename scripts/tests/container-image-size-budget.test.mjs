import assert from "node:assert/strict";
import test from "node:test";
import {
  containerImageSizeBudgets,
  evaluateImageSize,
  formatMebibytes
} from "../container-image-size-budget.mjs";

const mebibyte = 1024 * 1024;

test("public container targets declare explicit size budgets", () => {
  assert.equal(containerImageSizeBudgets.core, 850 * mebibyte);
  assert.equal(containerImageSizeBudgets.browser, 1350 * mebibyte);
  assert.equal(containerImageSizeBudgets.cli, 1000 * mebibyte);
});

test("budget evaluation accepts images at or under budget and rejects regressions", () => {
  const within = evaluateImageSize({
    target: "core",
    sizeBytes: 750 * mebibyte
  });
  assert.equal(within.ok, true);
  assert.equal(within.sizeFormatted, "750.0 MiB");
  assert.equal(within.budgetFormatted, "850.0 MiB");

  const over = evaluateImageSize({
    target: "cli",
    sizeBytes: 1001 * mebibyte
  });
  assert.equal(over.ok, false);
  assert.equal(formatMebibytes(over.sizeBytes - over.budgetBytes), "1.0 MiB");
});

test("budget evaluation rejects unknown targets and invalid sizes", () => {
  assert.throws(
    () => evaluateImageSize({ target: "desktop", sizeBytes: 100 * mebibyte }),
    /Unknown container image target/
  );
  assert.throws(
    () => evaluateImageSize({ target: "core", sizeBytes: 0 }),
    /Invalid container image size/
  );
});
