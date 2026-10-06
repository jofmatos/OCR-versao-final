import test from "node:test";
import assert from "node:assert/strict";
import { imageBands, MAX_VISION_PATCHES, readableNeuralError } from "../../browser/neural-image.js";

function image(width, height, gray = 255) {
  return { width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(gray) };
}

test("A4, landscape and square pages stay within the rounded vision budget", () => {
  for (const [width, height] of [[1089, 1540], [1540, 1089], [1540, 1540], [1120, 792]]) {
    const bands = imageBands(image(width, height, 0));
    let next = 0;
    for (const band of bands) {
      assert.equal(band.top, next, "Rows must not overlap or disappear");
      assert.equal(band.blank, false);
      const patches = Math.ceil(width / 28) * 2 * Math.ceil((band.bottom - band.top) / 28) * 2;
      assert.ok(patches <= MAX_VISION_PATCHES, `${patches} vision patches exceed the memory budget`);
      next = band.bottom;
    }
    assert.equal(next, height);
    assert.ok(bands.length > 1);
  }
});

test("cuts move into whitespace and blank strips never invoke the model", () => {
  const page = image(1008, 800);
  // A line crosses the nominal boundary at 392; the cut must move before it.
  page.data.fill(0, 375 * 1008 * 3, 405 * 1008 * 3);
  const bands = imageBands(page);
  assert.ok(bands[0].bottom < 375);
  const active = bands.filter((band) => !band.blank);
  assert.equal(active.length, 1);
  assert.ok(active[0].top <= 375 && active[0].bottom >= 405);
  assert.equal(imageBands(image(1000, 260)).filter((band) => !band.blank).length, 0);
});

test("small images retain one region and allocation failures are actionable", () => {
  assert.deepEqual(imageBands(image(1000, 260, 0)), [{ top: 0, bottom: 260, blank: false }]);
  const message = readableNeuralError(new Error("failed to call OrtRun(). SafeIntOnOverflow() Integer overflow"));
  assert.match(message, /memória/);
  assert.doesNotMatch(message, /\/mnt\/|OrtRun/);
  assert.equal(readableNeuralError(new Error("Download indisponível")), "Download indisponível");
});
