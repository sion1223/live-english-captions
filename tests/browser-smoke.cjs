const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { chromium } = require("C:/Users/sions/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

(async () => {
  let extension = path.resolve("extension"), relay, context, profile;
  const testPort = Number(process.env.CAPTION_TEST_PORT || 8765);
  const screenRateLimited = process.env.SCREEN_RATE_LIMIT === "1";
  if (screenRateLimited) assert.notEqual(testPort, 8765, "Fault injection requires an isolated test relay");
  try {
  if (testPort !== 8765) {
    assert.ok(Number.isInteger(testPort) && testPort > 1024 && testPort < 65536);
    assert.equal(await fetch("http://127.0.0.1:" + testPort + "/health").then(() => true, () => false), false, "Test port must be unused");
    extension = path.resolve(".run/isolated-extension-" + testPort);
    fs.mkdirSync(extension, { recursive: true });
    for (const file of fs.readdirSync("extension")) fs.copyFileSync(path.join("extension", file), path.join(extension, file));
    for (const file of ["background.js", "offscreen.js", "manifest.json"]) {
      const target = path.join(extension, file);
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("127.0.0.1:8765", "127.0.0.1:" + testPort));
    }
    const screenFault = screenRateLimited ? "\nimport translation\nreal_generate=translation.generate\ndef limited_generate(model,*args):\n if model==translation.SCREEN_TRANSLATION_MODEL: raise translation.TranslationBusyError(30)\n return real_generate(model,*args)\ntranslation.generate=limited_generate\n" : "\n";
    const code = "import asyncio,sys,server\nserver.PORT=" + testPort + screenFault + "\nasync def qa():\n task=asyncio.create_task(server.main())\n await asyncio.to_thread(sys.stdin.buffer.read,1)\n task.cancel()\n await asyncio.gather(task,return_exceptions=True)\nasyncio.run(qa())";
    relay = spawn(path.resolve(".venv/Scripts/python.exe"), ["-u", "-c", code], {
      windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    relay.stdout.on("data", () => {});
    relay.stderr.on("data", data => console.error("Test relay:", data.toString()));
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await fetch("http://127.0.0.1:" + testPort + "/health").then(response => response.ok, () => false);
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "isolated relay started");
  }
  profile = fs.mkdtempSync(path.resolve(".run/translation-smoke-"));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true,
    viewport: { width: 1100, height: 760 },
    args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension,
      "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
    let worker = context.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://")) ||
      await context.waitForEvent("serviceworker", { predicate: worker => worker.url().startsWith("chrome-extension://"), timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    context.on("serviceworker", next => { if (new URL(next.url()).host === extensionId) worker = next; });
    const expected = execFileSync(path.resolve(".venv/Scripts/python.exe"), ["-c", "from native_host import extension_id; print(extension_id())"], { encoding: "utf8" }).trim();
    if (testPort === 8765) assert.equal(extensionId, expected, "Native host must allow the actual unpacked extension ID");
    await worker.evaluate(() => chrome.storage.local.set({ screenTranslation: true, screenInterval: 3 }));
    const wav = fs.readFileSync(".run/samples/1.wav").toString("base64");
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#eceff1">
      <div id="movie_player" style="position:relative;width:min(960px,100vw);aspect-ratio:16/9;background:#e8eef4">
      <video autoplay muted playsinline style="width:100%;height:100%"></video></div>
      <audio loop src="data:audio/wav;base64,${wav}"></audio>
      <script>
      const canvas = document.createElement('canvas'); canvas.width=960; canvas.height=540;
      const ctx=canvas.getContext('2d');
      let frameText='게임을 시작합니다';
      window.paint=(text=frameText)=>{frameText=text;ctx.fillStyle='#e8eef4';ctx.fillRect(0,0,960,540);ctx.fillStyle='#223343';ctx.font='36px Malgun Gothic';ctx.fillText(text,60,215);ctx.fillStyle='#e07175';ctx.fillRect(660,330,170,100);};
      paint(); setInterval(()=>paint(),200);
      (async()=>{const audio=document.querySelector('audio');await audio.play();
      const stream=canvas.captureStream(5); audio.captureStream().getAudioTracks().forEach(t=>stream.addTrack(t));
      const video=document.querySelector('video');video.srcObject=stream;await video.play();})();
      </script></body></html>`;
    await context.route("https://www.youtube.com/**", route => route.fulfill({ contentType: "text/html", body: html }));
    let page = await context.newPage();
    let cdp = await context.newCDPSession(page);
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.log("Page error:", error.message); });
    await page.goto("https://www.youtube.com/watch?v=translation-smoke", { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    await page.locator("#local-english-captions").waitFor();
    await page.waitForFunction(() => document.querySelector("video").videoWidth > 0);
    console.log("Video:", await page.evaluate(() => ({ hidden: document.hidden, width: document.querySelector('video').videoWidth, ready: document.querySelector('video').readyState })));
    const fixture = await page.evaluate(() => canvas.toDataURL('image/jpeg', 0.82));
    fs.writeFileSync('.run/screen-fixture.jpg', Buffer.from(fixture.split(',')[1], 'base64'));
    await worker.evaluate(() => {
      globalThis.qaScreenCount = 0;
      globalThis.qaCaptionDelays = [];
      chrome.runtime.onMessage.addListener(message => {
        if (message.type === 'SCREEN_FRAME') globalThis.qaScreenCount++;
        if (message.type === 'EVENT' && message.event?.type === 'transcript')
          globalThis.qaCaptionDelays.push(message.event.translation_ms);
      });
    });
    await cdp.send("DOM.enable");
    cdp.on("Runtime.exceptionThrown", event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
    await cdp.send("Runtime.enable");
    async function nodes() {
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const collected = [];
      const visit = (node, inside = false) => {
        const attributes = node.attributes || [];
        const ours = inside || attributes.some((value, index) => index % 2 === 0 && value === "id" && attributes[index + 1] === "local-english-captions");
        if (ours) collected.push(node);
        for (const item of [...node.children || [], ...node.shadowRoots || []]) visit(item, ours);
      };
      visit(root);
      return collected;
    }
    async function byClass(name) {
      return (await nodes()).filter(node => {
        const attributes = node.attributes || [], index = attributes.findIndex((value, i) => i % 2 === 0 && value === "class");
        return index >= 0 && attributes[index + 1].split(" ").includes(name);
      });
    }
    async function inspect(node) {
      const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
      const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
        functionDeclaration: "function(){const r=this.getBoundingClientRect();return {text:this.textContent,hidden:this.hidden,disabled:this.disabled,x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:this.scrollWidth,clientWidth:this.clientWidth};}" });
      return result.value;
    }
    async function click(name, direct = false) {
      const [node] = await byClass(name); assert.ok(node, name);
      if (direct) {
        const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
        await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){this.click();}", userGesture: true });
        return;
      }
      const box = await inspect(node);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    const state = () => worker.evaluate(() => chrome.runtime.sendMessage({ target: "offscreen", type: "STATE" })).catch(() => null);
    async function until(predicate, label, timeout = 35000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const value = await predicate(); if (value) return value;
        } catch (error) {
          if (!/No node with given id found/.test(error.message)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      console.log("State:", await state());
      console.log("Badge:", await Promise.all((await byClass("badge")).map(inspect)));
      if (testPort === 8765) console.log("Native:", await worker.evaluate(() => chrome.runtime.sendNativeMessage("com.live_english_captions.launcher", { action: "ensure_server" }).catch(error => ({ error: error.message }))));
      console.log("Screen:", await Promise.all((await byClass("screen-state")).map(inspect)));
      console.log("Screen requests:", await worker.evaluate(() => globalThis.qaScreenCount));
      console.log("Video state:", await page.evaluate(() => {
        const v = document.querySelector("video");
        return v && { ready: v.readyState, paused: v.paused, time: v.currentTime, error: v.error?.code };
      }));
      await page.screenshot({ path: ".run/translation-failed.png" });
      throw new Error("Timed out: " + label);
    }
    if (screenRateLimited) {
      await click("toggle");
      await until(async () => (await inspect((await byClass("screen-state"))[0])).text.includes("화면 번역만 대기"),
        "only the screen track is waiting for retry");
      await until(async () => (await state())?.lastCaption?.text, "first audio caption during screen rate limit", 20000);
      const first = (await state()).lastCaption.updatedAt;
      await until(async () => (await state())?.lastCaption?.updatedAt > first + 3000,
        "audio captions continue throughout screen backoff", 20000);
      const current = await state();
      assert.equal(current.status, "listening");
      assert.equal(current.wanted, true);
      assert.ok(!current.translationWarning);
      assert.equal(await worker.evaluate(() => globalThis.qaScreenCount), 1, "screen retries must wait for their own deadline");
      assert.deepEqual(errors, []);
      await page.screenshot({ path: ".run/screen-rate-limit.png" });
      console.log("Screen model forced into 30-second backoff; real audio captions kept updating with no audio warning or reconnect.");
      console.log("Audio delivery delays during screen-only backoff (ms):", await worker.evaluate(() => globalThis.qaCaptionDelays));
      await click("toggle");
      await until(async () => !(await state())?.wanted, "stop after isolated screen failure");
    }
    if (!screenRateLimited && process.env.REAL_YOUTUBE !== "only") {
    const started = Date.now();
    await click("toggle");
    await until(async () => (await state())?.status === "listening", "one-click native startup");
    console.log(testPort === 8765 ? "One click started native server and audio:" : "One click connected isolated server and audio:", Date.now() - started, "ms");
    const relayHealth = await fetch("http://127.0.0.1:" + testPort + "/health").then(response => response.json());
    assert.equal((await state()).engine, relayHealth.transcription_engine || "gemini");
    const labels = await until(async () => {
      const labels = await byClass("screen-label"); return labels.length ? Promise.all(labels.map(inspect)) : false;
    }, "English label beside Korean video text");
    assert.ok(labels.some(item => /start|begin/i.test(item.text)), JSON.stringify(labels));
    for (const label of labels) {
      assert.ok(label.x >= 0 && label.x + label.width <= 960);
      assert.ok(label.y >= 0 && label.y + label.height <= 540);
      assert.ok(label.scrollWidth <= label.clientWidth);
    }
    console.log("Screen translation:", labels.map(label => label.text).join(" | "));
    console.log("Screen latency:", (await inspect((await byClass("screen-state"))[0])).text);
    await until(async () => (await state())?.lastCaption?.text, "English audio caption");
    console.log("Audio caption received; automatic language detection and English output are live.");
    console.log("Post-transcription delivery delay with screen translation enabled (ms):",
      await worker.evaluate(() => globalThis.qaCaptionDelays));
    await page.screenshot({ path: ".run/translation-desktop.png" });
    await page.setViewportSize({ width: 390, height: 700 });
    await until(async () => {
      const labels = await byClass("screen-label"); return labels.length > 0;
    }, "mobile labels");
    for (const label of await Promise.all((await byClass("screen-label")).map(inspect))) {
      assert.ok(label.x >= 0 && label.x + label.width <= 390);
      assert.ok(label.scrollWidth <= label.clientWidth);
    }
    await page.screenshot({ path: ".run/translation-mobile.png" });
    await click("settings");
    const frame = await until(() => page.frames().find(frame => frame.url().includes("popup.html?tabId=")), "settings panel");
    assert.equal(await frame.locator("#provider").count(), 0);
    await frame.locator("#key-saved").filter({ hasText: "API 키 저장됨" }).waitFor();
    assert.equal(await frame.locator("#api-key").inputValue(), "");
    if (relayHealth.providers?.transcription === "factchat") {
      assert.match(await frame.locator("#engine").innerText(), /FactChat.*Soniox/);
      assert.match(await frame.locator("#screen-key-detail").textContent(), /함께 사용/);
    }
    await frame.locator("#screen-enabled").uncheck();
    await until(async () => (await byClass("screen-label")).length === 0, "screen toggle clears labels");
    await frame.locator("#screen-enabled").check();
    await click("close");
    await page.evaluate(() => window.paint(""));
    await until(async () => (await byClass("screen-label")).length === 0, "scene change clears stale label");
    await click("settings");
    const nextWorker = context.waitForEvent("serviceworker", { predicate: worker => worker.url().startsWith("chrome-extension://"), timeout: 15000 });
    await worker.evaluate(() => chrome.runtime.reload()).catch(error => {
      if (!/closed|destroyed/i.test(error.message)) throw error;
    });
    worker = await nextWorker;
    await until(async () => (await inspect((await byClass("toggle"))[0])).text === "탭 새로고침", "old context cleanup after extension reload");
    assert.equal((await inspect((await byClass("caption"))[0])).hidden, true);
    assert.equal((await inspect((await byClass("settings"))[0])).disabled, true);
    assert.equal((await inspect((await byClass("panel"))[0])).hidden, true);
    assert.equal((await byClass("screen-label")).length, 0);
    await page.evaluate(() => {
      document.body.append(document.createElement("div"));
      document.dispatchEvent(new Event("yt-navigate-finish"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.match((await inspect((await byClass("badge"))[0])).text, /새로고침/);
    await page.screenshot({ path: ".run/extension-reload.png" });
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), click("toggle")]);
    await page.locator("#local-english-captions").waitFor();
    await page.waitForFunction(() => document.querySelector("video").videoWidth > 0);
    assert.equal(await page.locator("#local-english-captions").count(), 1);
    await click("toggle");
    await until(async () => (await state())?.status === "listening", "captions restart after page reload");
    console.log("Extension reload during capture: no uncaught exceptions, old tasks cleared, reload button restores captions.");
    await click("toggle");
    await until(async () => !(await state())?.wanted, "stop releases capture");
    assert.deepEqual(errors, []);
    console.log("Responsive placement, saved key, screen toggle, scene changes and stop passed.");

    // Exercise HTMLMediaElement.captureStream(), not only a cloned srcObject stream.
    await worker.evaluate(() => chrome.storage.local.set({ screenTranslation: false }));
    await page.evaluate(async () => {
      const video = document.querySelector("video"), audio = document.querySelector("audio");
      video.srcObject = null;
      video.src = audio.src;
      video.loop = true;
      audio.pause();
      await video.play();
    });
    await click("toggle");
    await until(async () => (await state())?.lastCaption?.text, "native media-element capture produces captions");
    const changedAt = Date.now();
    await page.evaluate(async () => {
      const video = document.querySelector("video");
      const src = video.src;
      video.removeAttribute("src");
      video.load();
      await new Promise(resolve => setTimeout(resolve, 1800));
      video.src = src;
      await video.play();
    });
    await until(async () => (await state())?.lastCaption?.updatedAt > changedAt + 2500,
      "ended audio track reconnects after source replacement");
    assert.deepEqual(errors, []);
    console.log("Native captureStream and source replacement both deliver captions without uncaught errors.");
    await page.evaluate(() => {
      history.pushState({}, "", "/");
      document.dispatchEvent(new Event("yt-navigate-finish"));
    });
    await until(async () => !(await state())?.wanted, "returning to YouTube home releases the session");
    console.log("YouTube home navigation releases the old session.");
    }

    if (!screenRateLimited && ["1", "only"].includes(process.env.REAL_YOUTUBE)) {
      await worker.evaluate(() => chrome.storage.local.set({ screenTranslation: false }));
      await context.unroute("https://www.youtube.com/**");
      await cdp.detach();
      await page.close();
      page = await context.newPage();
      cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("https://www.youtube.com/watch?v=cqexC_KlAnw&t=245s", { waitUntil: "domcontentloaded" });
      await page.locator("#local-english-captions").waitFor();
      await page.waitForFunction(() => {
        const video = document.querySelector("#movie_player video");
        return video?.readyState >= 2 && !video.error;
      }, null, { timeout: 30000 });
      await page.evaluate(async () => { const video = document.querySelector("#movie_player video"); video.muted = true; await video.play(); });
      await click("toggle", true);
      await until(async () => (await state())?.lastCaption?.text?.length >= 20, "real YouTube speech reaches the subtitle overlay", 45000);
      assert.equal((await inspect((await byClass("caption"))[0])).hidden, false);
      await page.screenshot({ path: ".run/youtube-captions.png" });
      console.log("Real YouTube playback: English speech caption is visible.");
      await click("toggle", true);
      await until(async () => !(await state())?.wanted, "real YouTube stop");
    }
    await cdp.detach();
  } finally {
    await context?.close();
    if (relay && relay.exitCode === null) {
      const exited = once(relay, "exit");
      relay.stdin.end("x");
      await exited;
    }
    const runRoot = path.resolve(".run") + path.sep;
    if (profile && path.resolve(profile).startsWith(runRoot) && path.basename(profile).startsWith("translation-smoke-")) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
