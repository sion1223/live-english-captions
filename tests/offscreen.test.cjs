const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

test("audio reconnect honors Google's long quota deadline and deduplicates timers", () => {
  const timers = [];
  const sandbox = vm.createContext({
    clearInterval() {}, clearTimeout() {}, setInterval() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    CaptionContext: class { check() { return true; } call(operation) { return Promise.resolve(operation()); } },
    chrome: { runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } } },
  });
  vm.runInContext(fs.readFileSync("extension/offscreen.js", "utf8"), sandbox);
  vm.runInContext('current = { wanted: true }; reconnect(0, "rate limited", 3600); reconnect(0);', sandbox);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 3600000);
  assert.equal(vm.runInContext("current.wanted", sandbox), true);
});
