import test from "node:test";
import assert from "node:assert/strict";
import { devicePolicy, compatibleEngine } from "../../browser/device-policy.js";

test("mobile WebGPU does not restore the desktop model or Mac companion", () => {
  for (const device of [
    { userAgent: "iPhone OS 26", platform: "iPhone" },
    { userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 },
    { userAgent: "Android Chrome", platform: "Linux", deviceMemory: 8 },
    { userAgent: "Chrome", userAgentData: { mobile: true } },
  ]) {
    const policy = devicePolicy({ ...device, gpu: {} });
    assert.equal(policy.mobile, true);
    assert.equal(compatibleEngine("neural", policy), "tesseract");
    assert.equal(compatibleEngine("vision", policy), "tesseract");
    assert.equal(compatibleEngine("paddle", policy), "paddle");
    assert.equal(policy.pixelLimit, 4_000_000);
  }
});

test("desktop selection respects GPU, memory and the Mac companion platform", () => {
  const mac = { userAgent: "Macintosh Chrome", platform: "MacIntel", gpu: {}, deviceMemory: 8 };
  assert.equal(compatibleEngine("neural", devicePolicy(mac)), "neural");
  assert.equal(compatibleEngine("vision", devicePolicy(mac)), "vision");
  assert.equal(compatibleEngine("neural", devicePolicy({ ...mac, gpu: null })), "tesseract");
  assert.equal(compatibleEngine("neural", devicePolicy({ ...mac, deviceMemory: 4 })), "tesseract");
  assert.equal(compatibleEngine("neural", devicePolicy(mac, false)), "tesseract");
  assert.equal(compatibleEngine("vision", devicePolicy({ ...mac, platform: "Win32", userAgent: "Windows Chrome" })), "tesseract");
});
