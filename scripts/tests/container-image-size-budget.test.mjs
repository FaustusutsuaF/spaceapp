import assert from "node:assert/strict";
import test from "node:test";
import {
  containerImageSizeBudgets,
  containerImageSizeMeasurements,
  evaluateContainerImageSize
} from "../container-image-size-budget.mjs";

const mebibyte = 1024 * 1024;

test("public container size budgets preserve the lightweight release ceilings", () => {
  assert.deepEqual(containerImageSizeBudgets, {
    core: 830 * mebibyte,
    browser: 1180 * mebibyte,
    cli: 730 * mebibyte
  });
});

test("recorded linux/amd64 and linux/arm64 image measurements stay within target budgets", () => {
  const expectedMeasurements = {
    "linux/amd64": {
      core: { sizeBytes: 785796740, sizeFormatted: "749.4 MiB" },
      browser: { sizeBytes: 1138549184, sizeFormatted: "1085.8 MiB" },
      cli: { sizeBytes: 669226218, sizeFormatted: "638.2 MiB" }
    },
    "linux/arm64": {
      core: { sizeBytes: 819042739, sizeFormatted: "781.1 MiB" },
      browser: { sizeBytes: 1169602558, sizeFormatted: "1115.4 MiB" },
      cli: { sizeBytes: 702410611, sizeFormatted: "669.9 MiB" }
    }
  };

  assert.deepEqual(
    Object.keys(containerImageSizeMeasurements),
    Object.keys(expectedMeasurements)
  );
  for (const [architecture, targets] of Object.entries(expectedMeasurements)) {
    assert.deepEqual(
      Object.keys(containerImageSizeMeasurements[architecture]),
      Object.keys(targets)
    );
    for (const [target, expected] of Object.entries(targets)) {
      const sizeBytes = containerImageSizeMeasurements[architecture][target];
      assert.equal(sizeBytes, expected.sizeBytes);
      const evaluation = evaluateContainerImageSize({ target, sizeBytes });
      assert.equal(evaluation.ok, true, `${architecture} ${target} exceeded budget`);
      assert.equal(evaluation.sizeFormatted, expected.sizeFormatted);
      assert.ok(evaluation.remainingBytes > 0);
    }
  }
});

test("container size budget accepts an image exactly at its target ceiling", () => {
  assert.deepEqual(
    evaluateContainerImageSize({
      target: "cli",
      sizeBytes: containerImageSizeBudgets.cli
    }),
    {
      target: "cli",
      sizeBytes: containerImageSizeBudgets.cli,
      budgetBytes: containerImageSizeBudgets.cli,
      remainingBytes: 0,
      sizeFormatted: "730.0 MiB",
      budgetFormatted: "730.0 MiB",
      ok: true
    }
  );
});

test("container size budget blocks an image one byte over its target ceiling", () => {
  const sizeBytes = containerImageSizeBudgets.core + 1;

  assert.deepEqual(evaluateContainerImageSize({ target: "core", sizeBytes }), {
    target: "core",
    sizeBytes,
    budgetBytes: containerImageSizeBudgets.core,
    remainingBytes: -1,
    sizeFormatted: "830.0 MiB",
    budgetFormatted: "830.0 MiB",
    ok: false
  });
});

test("container size budget rejects unknown targets", () => {
  assert.throws(
    () => evaluateContainerImageSize({ target: "unknown", sizeBytes: 1 }),
    /Unknown container target/
  );
});
