import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { parsePaddleDictionary } from "../../browser/paddle-dictionary.js";

const bytes = await readFile(new URL("../fixtures/paddle-v5-latin-dict.txt", import.meta.url));

test("redistributed dictionary normalizes to the official PaddleOCR Latin dictionary", () => {
  const characters = parsePaddleDictionary(bytes);
  assert.equal(characters.length, 836);
  const hash = createHash("sha256").update(characters.join("\n") + "\n").digest("hex");
  assert.equal(hash, "ccbcc45730b3fbbd9050c5bc74db6a99067141ef1035e3d14889a84a6b9b1aff");
});

test("actual SDK CTC decoder preserves Portuguese accents and numbers", async () => {
  // Exercise the decoder shipped by our pinned SDK, rather than duplicating it.
  const source = await readFile(new URL("../../node_modules/@paddleocr/paddleocr-js/dist/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function decodeCTCSample(");
  const end = source.indexOf("function postprocess(output, charDict)", start);
  assert.ok(start >= 0 && end > start, "Pinned SDK decoder could not be located");
  const decode = runInNewContext(source.slice(start, end) + "\ndecodeCTCSample");
  const characters = [...parsePaddleDictionary(bytes), " "];
  const expected = "Português: ação, educação e 12345.";
  const classes = characters.length + 1;
  const output = new Float32Array(expected.length * 2 * classes);
  [...expected].forEach((character, index) => {
    const position = characters.indexOf(character);
    assert.ok(position >= 0, `Missing character ${character}`);
    output[index * 2 * classes + position + 1] = 0.99;
    output[(index * 2 + 1) * classes] = 0.99;
  });
  const decoded = decode(output, 0, expected.length * 2, classes, characters);
  assert.equal(decoded.text, expected);
  // Reproduce the regression: the previous extra blank shifts the same logits.
  const broken = ["", ...characters];
  assert.notEqual(decode(output, 0, expected.length * 2, classes, broken).text, expected);
});

test("invalid entries are rejected while literal spaces remain intact", () => {
  const encode = (text) => new TextEncoder().encode(text);
  assert.deepEqual(parsePaddleDictionary(encode("\uFEFF\r\n0\r\nç\r\n \r\n")), ["0", "ç", " "]);
  assert.throws(() => parsePaddleDictionary(encode("0\n\n1\n")));
  assert.throws(() => parsePaddleDictionary(encode("\n\n")));
});
