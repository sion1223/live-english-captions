const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.resolve("extension/runtime-context.js"), "utf8");

function fixture() {
  const chrome = { runtime: { id: "test-extension" } };
  const sandbox = vm.createContext({ chrome });
  vm.runInContext(source, sandbox);
  let cleanups = 0;
  const context = new sandbox.CaptionContext(() => { cleanups++; });
  return { chrome, context, notice: sandbox.CaptionContext.notice, cleanups: () => cleanups };
}

test("synchronous Chrome errors become handled rejections and dispose once", async () => {
  const f = fixture();
  let pending;
  assert.doesNotThrow(() => {
    pending = f.context.call(() => { throw new Error("Extension context invalidated."); });
  });
  await assert.rejects(pending, { message: f.notice });
  let calls = 0;
  await assert.rejects(f.context.call(() => { calls++; }), { message: f.notice });
  assert.equal(calls, 0);
  assert.equal(f.cleanups(), 1);
});

test("asynchronous invalidation triggers the same cleanup", async () => {
  const f = fixture();
  await assert.rejects(f.context.call(() => Promise.reject(new Error("Extension context invalidated."))), { message: f.notice });
  assert.equal(f.cleanups(), 1);
});

test("missing extension id prevents further API calls", async () => {
  const f = fixture();
  f.chrome.runtime.id = undefined;
  let calls = 0;
  await assert.rejects(f.context.call(() => { calls++; }), { message: f.notice });
  assert.equal(f.context.check(), false);
  assert.equal(calls, 0);
  assert.equal(f.cleanups(), 1);
});

test("an invalidated runtime getter cannot escape the lifecycle check", () => {
  const f = fixture();
  Object.defineProperty(f.chrome.runtime, "id", { get() { throw new Error("Extension context invalidated."); } });
  assert.equal(f.context.check(), false);
  assert.equal(f.cleanups(), 1);
});

test("ordinary failures stay recoverable without disabling the extension", async () => {
  const f = fixture();
  await assert.rejects(f.context.call(() => Promise.reject(new Error("Server unavailable"))), { message: "Server unavailable" });
  assert.equal(f.cleanups(), 0);
  assert.equal(await f.context.call(() => Promise.resolve(42)), 42);
});

test("a late storage or message response cannot revive a disposed context", async () => {
  const f = fixture();
  let complete;
  const pending = f.context.call(() => new Promise(resolve => { complete = resolve; }));
  f.chrome.runtime.id = undefined;
  assert.equal(f.context.check(), false);
  complete({ wanted: true });
  await assert.rejects(pending, { message: f.notice });
  assert.equal(f.cleanups(), 1);
});
