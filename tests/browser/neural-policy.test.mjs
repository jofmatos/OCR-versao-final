import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_ID, GLM_MODEL_ID, validateManifest, repeatsTokens, recognitionWarnings } from "../../browser/neural-policy.js";

test("only a complete, revision-locked model can be enabled", () => {
  const spec = { available: true, model: MODEL_ID, revision: "a".repeat(40), dtype: "q4", bytes: 800000000, sizes: { "onnx/embed_tokens_q4.onnx": 100000000, "onnx/vision_encoder_q4.onnx": 300000000, "onnx/decoder_model_merged_q4.onnx": 400000000 } };
  assert.equal(validateManifest(spec), spec);
  assert.equal(validateManifest({ ...spec, model: GLM_MODEL_ID }).model, GLM_MODEL_ID);
  for (const override of [{ available: false }, { model: "other/model" }, { revision: "main" }, { dtype: "fp32" }, { bytes: 3000000000 }, { sizes: {} }, { bytes: 800000001 }]) {
    assert.throws(() => validateManifest({ ...spec, ...override }));
  }
});

test("runaway generation is stopped while normal and short repeated text is retained", () => {
  assert.equal(repeatsTokens([1, 2, 1, 2, 1, 2]), false);
  assert.equal(repeatsTokens(Array.from({ length: 80 }, (_, index) => index)), false);
  assert.equal(repeatsTokens(Array(70).fill(42n)), true);
  assert.equal(repeatsTokens(Array.from({ length: 128 }, (_, index) => BigInt(index % 16))), true);
  assert.equal(repeatsTokens([...Array(80).fill(42), 10, 11, 12]), false);
});

test("truncated output stays explicit and no confidence percentage is invented", () => {
  assert.equal(recognitionWarnings().length, 1);
  const warnings = recognitionWarnings({ repeated: true, limited: true }).join(" ");
  assert.match(warnings, /generativo/);
  assert.match(warnings, /repetição/);
  assert.match(warnings, /incompleto/);
  assert.doesNotMatch(warnings, /\d+%/);
});
