import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-qwen38-vision-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { isVisionModelId } = await import("../../src/shared/constants/visionModels.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("qwen3.8 family resolves vision capability for passthrough providers (bai)", () => {
  // bai is a passthroughModels provider — the model id has no registry entry, no
  // models.dev sync, no static spec. It must fall through to the shared
  // VISION_MODEL_ID_FRAGMENTS heuristic ("qwen3.8").
  for (const modelId of ["bai/qwen3.8-flash", "qwen3.8-flash", "ali/qwen3.8-flash"]) {
    const capabilities = getResolvedModelCapabilities(modelId);
    assert.equal(
      capabilities.supportsVision,
      true,
      `${modelId} supports vision (qwen3.8 family, image request must route)`
    );
  }
});

test("GLM-5.3-Flash / GLM-5V family resolves vision capability for passthrough providers (bai)", () => {
  // Z.ai native multimodal GLM-5 models (verified against docs.z.ai):
  //   - GLM-5.3-Flash: "first native multimodal model in the GLM-5 series"
  //   - GLM-5V-Turbo:  input modalities Video/Image/Text/File
  // These must resolve true via VISION_MODEL_ID_FRAGMENTS ("glm-5.3-flash", "glm-5v").
  for (const modelId of [
    "bai/glm-5.3-flash",
    "glm-5.3-flash",
    "bai/glm-5v-turbo",
    "glm-5v-turbo",
    "bai/glm-5v",
  ]) {
    const capabilities = getResolvedModelCapabilities(modelId);
    assert.equal(
      capabilities.supportsVision,
      true,
      `${modelId} supports vision (native multimodal GLM-5, image request must route)`
    );
  }
});

test("GLM-5.1 / GLM-5.2 / GLM-5.3 (base) are TEXT-ONLY — must NOT be flagged vision", () => {
  // Z.ai docs + community verification: GLM-5.1, GLM-5.2, and GLM-5.3 (base) are
  // text-in/text-out only ("input modalities: Text"). Flagging them vision would
  // re-create #4071 (image routed to a model that cannot see it). Fragments are
  // "glm-5.3-flash" and "glm-5v" — never a bare "glm-5.1/5.2/5.3" prefix.
  for (const modelId of [
    "bai/glm-5.1",
    "glm-5.1",
    "bai/glm-5.2",
    "glm-5.2",
    "bai/glm-5.3",
    "glm-5.3",
    "opencode-go/glm-5.1",
    "opencode-zen/glm-5.2",
  ]) {
    assert.equal(
      isVisionModelId(modelId),
      false,
      `${modelId} must NOT be flagged vision — GLM-5.1/5.2/5.3 base are text-only`
    );
  }
});

test("qwen3.8 fragment does not leak into older text-only qwen3.5/3.6/3.7 (regression #2822)", () => {
  // #2822: qwen3.5-plus / qwen3.6-plus / qwen3.7-max on opencode-go / opencode-zen
  // are TEXT-ONLY and must NOT be flagged vision by the fragment heuristic.
  for (const modelId of [
    "qwen3.5-plus",
    "qwen3.6-plus",
    "qwen3.7-max",
    "opencode-go/qwen3.7-max",
    "opencode-zen/qwen3.5-plus",
    "opencode-zen/qwen3.6-plus",
  ]) {
    // isVisionModelId must be false for all of these — the fragment is "qwen3.8",
    // never a bare "qwen3" prefix.
    assert.equal(
      isVisionModelId(modelId),
      false,
      `${modelId} must NOT be flagged vision by the id heuristic (#2822)`
    );
  }
});
