const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

function fixture() {
  let now = 100000, pixels = new Uint8ClampedArray(64 * 36 * 4).fill(100), response = { items: [] };
  const requests = [];
  const sandbox = vm.createContext({ document: { hidden: false }, Date: { now: () => now }, performance: { now: () => now } });
  vm.runInContext(fs.readFileSync("extension/screen-text.js", "utf8"), sandbox);
  const screen = Object.create(sandbox.CaptionScreen.prototype);
  const video = { readyState: 4, videoWidth: 64, videoHeight: 36 };
  Object.assign(screen, { active: true, enabled: true, context: { check: () => true }, epoch: 1,
    video: () => video, lastVideo: video, items: [], interval: 3000, nextAt: 0, retryAt: 0, emptyFrames: 0,
    layout() {}, note() {}, layer: { replaceChildren() {} },
    pixels: () => pixels, frame: async () => "data:image/jpeg;base64,/9j/",
    send: async () => { requests.push(now); return response; },
  });
  return { screen, requests, now: value => { now = value; }, response: value => { response = value; },
    pixels: value => { pixels = value; }, tick: async () => {
      await screen.tick();
      while (screen.inFlight) await new Promise(resolve => setImmediate(resolve));
    } };
}

test("codec noise skips cloud requests, but a small new text region is detected", async () => {
  const f = fixture();
  await f.tick();
  f.now(103500);
  f.pixels(new Uint8ClampedArray(64 * 36 * 4).fill(101));
  await f.tick();
  assert.equal(f.requests.length, 1);
  const textPixels = new Uint8ClampedArray(64 * 36 * 4).fill(101);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    for (let channel = 0; channel < 3; channel++) textPixels[(y * 64 + x) * 4 + channel] = 220;
  }
  f.pixels(textPixels);
  await f.tick();
  assert.equal(f.requests.length, 2);
});

test("empty frames slow polling and a new scene restores the base interval", async () => {
  const f = fixture();
  await f.tick();
  assert.equal(f.screen.nextAt, 106000);
  f.now(103500);
  f.pixels(new Uint8ClampedArray(64 * 36 * 4).fill(240));
  f.response({ items: [{ source: "텍스트", english: "Text", box: [0, 0, 500, 500] }] });
  await f.tick();
  assert.equal(f.requests.length, 2);
  assert.equal(f.screen.emptyFrames, 0);
  assert.equal(f.screen.nextAt, 106500);
});

test("quota cooldown survives scene invalidation and off/on switches", async () => {
  const f = fixture();
  f.response({ error: "Quota", retryAfter: 3600 });
  await f.tick();
  const deadline = f.screen.retryAt;
  f.screen.invalidate();
  assert.equal(f.screen.retryAt, deadline);
  f.screen.enabled = false;
  await f.tick();
  f.screen.enabled = true;
  f.now(130000);
  await f.tick();
  assert.equal(f.requests.length, 1);
});

test("turning screen translation off ignores an in-flight result", async () => {
  const f = fixture();
  let finish;
  f.screen.send = () => new Promise(resolve => { finish = resolve; });
  await f.screen.tick();
  f.screen.enabled = false;
  f.screen.invalidate();
  finish({ items: [{ source: "텍스트", english: "Text", box: [0, 0, 500, 500] }] });
  while (f.screen.inFlight) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.screen.items.length, 0);
});
