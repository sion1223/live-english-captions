const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

function fixture(previousUrl = "https://www.youtube.com/") {
  let current = { wanted: true, tabId: 1, sessionId: "old", status: "listening" };
  const calls = [];
  const preferences = {};
  const tabs = new Map([[1, { id: 1, url: previousUrl }], [2, { id: 2, url: "https://www.youtube.com/watch?v=next" }]]);
  let onUpdated;
  const sandbox = vm.createContext({
    URL, AbortSignal, console, importScripts() {},
    CaptionProfiles: { select: () => null, summary: () => null },
    fetch: async url => ({ json: async () => url.includes("/health") ?
      { app: "live-english-captions", protocol_version: 5, gemini_configured: true } : { profiles: [] } }),
    chrome: {
      runtime: {
        id: "test", getURL: file => "chrome-extension://test/" + file,
        getContexts: async () => [{}], onMessage: { addListener() {} },
        sendMessage: async message => {
          calls.push(message.type);
          if (message.type === "STOP") current = { ...current, wanted: false };
          if (message.type === "START_PAGE") current = { ...current, wanted: true, tabId: message.tabId, sessionId: "new" };
          return { ...current };
        },
      },
      tabs: {
        get: async id => { if (!tabs.has(id)) throw new Error("Tab closed"); return tabs.get(id); },
        update: async () => {},
        sendMessage: async (id, message) => message.type === "CHANNEL_INFO" ? { videoId: "next" } : { ok: true },
        onRemoved: { addListener() {} }, onUpdated: { addListener(callback) { onUpdated = callback; } },
      },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        local: { get: async defaults => ({ ...defaults, ...preferences }), set: async values => Object.assign(preferences, values) } },
      scripting: { executeScript: async () => {} },
    },
  });
  vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), sandbox);
  return { sandbox, calls, tabs, preferences, updated: (...args) => onUpdated(...args), state: () => current };
}

test("video page detection excludes home, search and unsupported origins", () => {
  const { sandbox } = fixture();
  for (const url of ["https://www.youtube.com/watch?v=abc", "https://youtube.com/shorts/abc", "https://www.youtube.com/live/abc"]) {
    assert.equal(sandbox.isVideoPage(url), true, url);
  }
  for (const url of [undefined, "https://www.youtube.com/", "https://www.youtube.com/results?search_query=abc", "https://www.youtube.com/watch", "https://other.example/watch?v=abc"]) {
    assert.equal(sandbox.isVideoPage(url), false, url);
  }
});

test("a leftover session on YouTube home does not block a new video", async () => {
  const f = fixture();
  const result = await f.sandbox.start({ tabId: 2, source: "page" }, {});
  assert.equal(result.wanted, true);
  assert.equal(result.tabId, 2);
  assert.ok(f.calls.indexOf("STOP") < f.calls.indexOf("START_PAGE"));
});

test("a closed old tab also releases its stale session", async () => {
  const f = fixture();
  f.tabs.delete(1);
  assert.equal((await f.sandbox.start({ tabId: 2 }, {})).tabId, 2);
  assert.ok(f.calls.includes("STOP"));
});

test("another valid video session is not silently taken over", async () => {
  const f = fixture("https://www.youtube.com/watch?v=playing");
  await assert.rejects(f.sandbox.start({ tabId: 2 }, {}), /다른 유튜브 탭/);
  assert.ok(!f.calls.includes("STOP"));
});

test("SPA navigation to home stops capture, but switching videos keeps it", async () => {
  const f = fixture();
  await f.updated(1, { url: "https://www.youtube.com/watch?v=another" }, { url: "https://www.youtube.com/watch?v=another" });
  assert.ok(!f.calls.includes("STOP"));
  await f.updated(1, { url: "https://www.youtube.com/" }, { url: "https://www.youtube.com/" });
  assert.equal(f.state().wanted, false);
});

test("channel navigation cleanup handles a missed tabs update", async () => {
  const f = fixture();
  await f.sandbox.updateChannel(1);
  assert.equal(f.state().wanted, false);
});

test("screen translation defaults off and never opens a socket while disabled", async () => {
  const f = fixture();
  await assert.rejects(f.sandbox.translateFrame({ sessionId: "old", image: "data:image/jpeg;base64,/9j/" }, { tab: { id: 1 } }), /취소/);
  assert.equal(f.state().wanted, true);
});

test("video screen switch never restarts the audio session", async () => {
  const f = fixture();
  const sender = { url: "https://www.youtube.com/watch?v=video", tab: { id: 1 } };
  await f.sandbox.handle({ type: "SCREEN_TOGGLE", enabled: true }, sender);
  assert.equal(f.preferences.screenTranslation, true);
  await f.sandbox.handle({ type: "SCREEN_TOGGLE", enabled: false }, sender);
  assert.equal(f.preferences.screenTranslation, false);
  assert.equal(f.state().sessionId, "old");
  assert.equal(f.state().wanted, true);
  assert.deepEqual(f.calls, []);
});
