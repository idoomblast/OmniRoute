import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ox-alpha-vision-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");

const VISION_TARGETS = [
  "opencode/x-preview-f-free",
  "opencode-zen/x-preview-f-free",
  "opencode-go/ox-alpha-free",
  "command-code/x-preview-f-free",
];

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("OX Alpha targets declare vision support", () => {
  for (const modelId of VISION_TARGETS) {
    const capabilities = getResolvedModelCapabilities(modelId);

    assert.equal(capabilities.supportsVision, true, `${modelId} supports vision`);
  }
});
