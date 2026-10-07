const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("C:/Users/sions/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    const overlay = fs.readFileSync("extension/content.js", "utf8").match(/shadow.innerHTML = `([\s\S]*?)`;/)[1];
    await page.setContent('<body style="margin:0;background:#eceff1"><div id="player" style="position:relative;width:min(960px,100vw);aspect-ratio:16/9"><canvas width="960" height="540" style="width:100%;height:100%"></canvas><div id="host" style="position:absolute;inset:0"></div></div></body>');
    await page.evaluate(html => {
      const host = document.querySelector("#host");
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = html;
      const canvas = document.querySelector("canvas"), ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e8eef4"; ctx.fillRect(0, 0, 960, 540);
      ctx.fillStyle = "#223343"; ctx.font = "32px Malgun Gothic";
      ctx.fillText("시작", 70, 170);
      ctx.fillText("설정", 540, 170);
      ctx.fillText("나가기", 70, 310);
      globalThis.chrome = { storage: { local: { get: async () => ({ screenTranslation: false }) }, onChanged: { addListener() {}, removeListener() {} } } };
    }, overlay);
    await page.addScriptTag({ path: path.resolve("extension/screen-text.js") });
    await page.evaluate(() => {
      const host = document.querySelector("#host"), canvas = document.querySelector("canvas");
      globalThis.screenTest = new CaptionScreen({ host, shadow: host.shadowRoot,
        video: () => ({ videoWidth: 960, videoHeight: 540, getBoundingClientRect: () => canvas.getBoundingClientRect() }),
        send: async () => ({}), context: { check: () => true, call: operation => Promise.resolve(operation()) } });
    });
    await page.evaluate(() => {
      screenTest.items = [
        { source: "시작", english: "Start", box: [258, 70, 321, 140], pair: 0 },
        { source: "설정", english: "Settings", box: [258, 560, 321, 632], pair: 1 },
        { source: "나가기", english: "Exit", box: [518, 70, 580, 172], pair: 2 },
      ];
      screenTest.layout();
    });
    async function verify(width) {
      await page.setViewportSize({ width, height: 650 });
      await page.evaluate(() => screenTest.layout());
      const pairs = await page.evaluate(() => {
        const shadow = document.querySelector("#host").shadowRoot;
        return [...shadow.querySelectorAll(".screen-label")].map(label => {
          const source = shadow.querySelector('.screen-source[data-pair="' + label.dataset.pair + '"]');
          const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          return { id: label.dataset.pair, sourceNumber: source.textContent,
            labelNumber: label.querySelector(".screen-number").textContent,
            color: getComputedStyle(label).borderColor, sourceColor: getComputedStyle(source).borderColor,
            label: rect(label), source: rect(source), overflow: label.scrollWidth > label.clientWidth };
        });
      });
      assert.equal(pairs.length, 3, "all three phrases must have a visible pair at " + width + "px");
      assert.equal(new Set(pairs.map(pair => pair.color)).size, 3);
      for (const pair of pairs) {
        assert.equal(pair.sourceNumber, pair.labelNumber);
        assert.equal(pair.color, pair.sourceColor);
        assert.equal(pair.overflow, false);
        assert.ok(pair.label.x >= 0 && pair.label.x + pair.label.width <= Math.min(width, 960));
        for (const other of pairs) {
          const a = pair.label, b = other.source;
          assert.ok(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y), "translation must not cover source text");
        }
      }
      await page.screenshot({ path: ".run/screen-pairs-" + width + ".png" });
    }
    await verify(1000);
    await verify(390);
    assert.equal(await page.evaluate(() => {
      const first = screenTest.layer.firstElementChild;
      screenTest.layout();
      return first === screenTest.layer.firstElementChild;
    }), true, "unchanged layout must reuse its DOM instead of rebuilding for each caption");
    await page.evaluate(() => { screenTest.items = screenTest.items.slice(1); screenTest.layout(); });
    assert.deepEqual(await page.locator(".screen-label").evaluateAll(labels => labels.map(label => label.dataset.pair)), ["2", "3"]);
    await page.evaluate(() => screenTest.invalidate());
    assert.equal(await page.locator(".screen-source,.screen-label").count(), 0);
    const captures = await page.evaluate(async () => {
      const canvas = document.querySelector("canvas");
      Object.defineProperties(canvas, {
        videoWidth: { value: 960 }, videoHeight: { value: 540 }, readyState: { value: 2 },
      });
      screenTest.video = () => canvas;
      screenTest.lastVideo = canvas;
      screenTest.active = screenTest.enabled = true;
      let encoded = 0, requests = 0, finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const frame = screenTest.frame.bind(screenTest);
      screenTest.frame = async video => { encoded++; return frame(video); };
      screenTest.send = async () => { requests++; return requests === 1 ? pending : { items: [] }; };
      await screenTest.tick();
      for (let i = 0; i < 6; i++) await screenTest.tick();
      const whilePending = { encoded, requests };
      finish({ items: [] });
      while (screenTest.inFlight) await new Promise(resolve => setTimeout(resolve, 0));
      screenTest.nextAt = 0;
      for (let i = 0; i < 6; i++) await screenTest.tick();
      const unchanged = { encoded, requests };
      canvas.getContext("2d").fillRect(0, 0, 960, 540);
      screenTest.nextAt = Date.now() + 3000;
      await screenTest.tick();
      const beforeDue = { encoded, requests };
      screenTest.nextAt = 0;
      await screenTest.tick();
      const changed = { encoded, requests };
      screenTest.destroy();
      return { whilePending, unchanged, beforeDue, changed };
    });
    assert.deepEqual(captures.whilePending, { encoded: 1, requests: 1 });
    assert.deepEqual(captures.unchanged, { encoded: 1, requests: 1 });
    assert.deepEqual(captures.beforeDue, { encoded: 1, requests: 1 });
    assert.deepEqual(captures.changed, { encoded: 2, requests: 2 });
    console.log("Matched pairs, desktop/mobile layout, DOM reuse, cleanup and request-only JPEG encoding passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
