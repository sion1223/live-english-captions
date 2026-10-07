(() => {
  if (globalThis.__liveEnglishCaptions) return;
  globalThis.__liveEnglishCaptions = true;
  const host = document.createElement("div");
  host.id = "local-english-captions";
  host.style.cssText = "position:absolute;inset:0;z-index:2147483000;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      * { box-sizing:border-box; }
      button { border:0;cursor:pointer;font:600 12px/1.4 system-ui,sans-serif; }
      button:focus-visible { outline:2px solid white;outline-offset:3px; }
      button:disabled { opacity:.65;cursor:wait; }
      .controls { position:absolute;top:12px;right:12px;display:flex;gap:4px;pointer-events:auto; }
      .toggle,.settings,.screen-toggle { min-height:34px;border-radius:8px;background:#101713eb;color:#e0f6d5;padding:7px 11px;box-shadow:0 2px 12px #0004; }
      .toggle:hover,.settings:hover,.screen-toggle:hover { background:#31472b; }
      .toggle.on,.screen-toggle.on { background:#b9ef8c;color:#14200e; }
      .settings { font-size:17px;padding:4px 10px; }
      .badge { position:absolute;top:14px;left:12px;padding:7px 10px;border-radius:8px;background:#101713e8;color:#d4f5c1;font:500 12px/1.5 system-ui,sans-serif;max-width:calc(100% - 185px);white-space:normal; }
      .caption { position:absolute;bottom:12%;left:50%;transform:translateX(-50%);width:max-content;max-width:var(--caption-width,80%);padding:6px 12px;border-radius:7px;background:#090c10d9;color:white;font:600 var(--caption-font,24px)/1.4 Arial,sans-serif;text-align:center;text-shadow:0 1px 3px #000;white-space:normal;overflow-wrap:anywhere; }
      .caption.final { color:#f4f7fa; }
      .screen-text { position:absolute;inset:0;overflow:hidden;pointer-events:none; }
      .screen-label { position:absolute;display:grid;grid-template-columns:18px minmax(0,1fr);gap:6px;padding:5px 8px;border:2px solid var(--pair-color);border-radius:4px;background:#101820f2;color:#f2f8fc;font:500 14px/1.35 Arial,sans-serif;text-align:left;overflow-wrap:anywhere;white-space:normal; }
      .screen-source { position:absolute;border:2px solid var(--pair-color);border-radius:3px;box-shadow:0 0 0 1px #101820b3; }
      .screen-number { display:inline-grid;place-items:center;width:18px;height:18px;border-radius:3px;background:var(--pair-color);color:#101820;font:700 11px/1 Arial,sans-serif; }
      .screen-source-number { position:absolute;box-shadow:0 0 0 1px #101820b3; }
      .screen-state { position:absolute;left:12px;bottom:44px;max-width:calc(100% - 24px);padding:4px 7px;border-radius:4px;background:#101820dd;color:#bce2f4;font:500 11px/1.4 system-ui,sans-serif;overflow-wrap:anywhere; }
      .panel { position:absolute;top:54px;right:12px;width:320px;max-width:calc(100% - 24px);height:min(640px,calc(100% - 70px));min-height:130px;pointer-events:auto;background:#111713;border:1px solid #42513d;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px #0008;display:flex;flex-direction:column; }
      .panel-head { display:flex;align-items:center;justify-content:space-between;padding:6px 12px;color:#b9c8b5;font:12px system-ui; }
      .close { background:transparent;color:#eef5ea;padding:5px 9px;font-size:18px; }
      iframe { width:100%;flex:1;min-height:0;border:0;background:#111713; }
      [hidden] { display:none !important; }
    </style>
    <div class="controls">
      <button class="toggle" type="button" aria-pressed="false">CC · 영어 자막</button>
      <button class="screen-toggle" type="button" aria-pressed="false" title="화면 글자 번역 켜기·끄기">화면 번역 OFF</button>
      <button class="settings" type="button" title="자막 설정 · API 키" aria-label="자막 설정" aria-expanded="false">⚙</button>
    </div>
    <div class="badge" role="status" hidden></div>
    <div class="caption" aria-live="off" hidden></div>
    <div class="screen-text" aria-live="off"></div>
    <div class="screen-state" role="status" hidden></div>
    <section class="panel" aria-label="자막 설정" hidden>
      <div class="panel-head"><span>자막 설정</span><button class="close" type="button" aria-label="설정 닫기">×</button></div>
    </section>`;
  const toggle = shadow.querySelector(".toggle"), settings = shadow.querySelector(".settings");
  const badge = shadow.querySelector(".badge"), caption = shadow.querySelector(".caption");
  const panel = shadow.querySelector(".panel");
  let view = { wanted: false, status: "idle", preferredEngine: "gemini" };
  let latest = "", busy = false, syncing = false, badgeTimer, mountQueued = false, captureTask;
  let peer, captured, capturedVideo, capturedSession, captureEvents, retryTimer, lastCaptureAttempt = 0;
  let viewerTabId, revision = 0, lastSequence = -1, frame;
  let captionStyle = { ...CaptionStyle.defaults };
  let channelTimer, channelFingerprint = "", navigating = false;
  let screenText, mutationObserver, resizeObserver, contextTimer;
  const events = new AbortController();
  const context = new CaptionContext(disconnect);

  const send = (type, extra = {}) => context.call(() => chrome.runtime.sendMessage({ target: "background", type, ...extra }));
  const videoElement = () => document.querySelector("#movie_player video") || document.querySelector("video");
  screenText = new CaptionScreen({ host, shadow, video: videoElement, send, context });
  if (!context.check()) { screenText.destroy(); return; }

  function disconnect() {
    revision++;
    view = { ...view, wanted: false, lastCaption: null };
    clearInterval(contextTimer);
    clearTimeout(channelTimer);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    events.abort();
    releaseCapture();
    screenText?.destroy();
    try { chrome.storage.onChanged.removeListener(onStyleChange); } catch { /* Already invalid. */ }
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Already invalid. */ }
    latest = "";
    render("");
    panel.hidden = true;
    frame?.remove();
    frame = null;
    settings.disabled = true;
    settings.setAttribute("aria-expanded", "false");
    toggle.disabled = false;
    toggle.classList.remove("on");
    toggle.setAttribute("aria-pressed", "false");
    toggle.textContent = "탭 새로고침";
    note(CaptionContext.notice);
  }

  function channelInfo() {
    const url = new URL(location.href);
    const videoId = url.searchParams.get("v") || url.pathname.match(/^\/(?:live|shorts)\/([^/]+)/)?.[1] || "";
    const watches = [...document.querySelectorAll("ytd-watch-flexy[video-id]")];
    const watch = watches.find(element => element.getAttribute("video-id") === videoId);
    if (navigating || !videoId || (watches.length && !watch)) return { videoId, ownerUrl: "" };
    // Scope to the actual video owner; recommendations and mentions in titles
    // often contain other channels' names.
    const owner = (watch || document).querySelector("ytd-watch-metadata #owner a[href^='/@'], ytd-watch-metadata #owner a[href^='/channel/'], #owner ytd-channel-name a[href], ytd-video-owner-renderer #channel-name a[href]");
    return { videoId, ownerUrl: owner?.href || "" };
  }

  function scheduleChannel() {
    if (!context.check() || channelTimer) return;
    channelTimer = setTimeout(() => {
      channelTimer = null;
      if (!context.check() || navigating) return;
      const info = channelInfo();
      const fingerprint = info.videoId + "|" + info.ownerUrl;
      if (fingerprint === channelFingerprint) return;
      channelFingerprint = fingerprint;
      void send("CHANNEL_CHANGED").catch(() => { channelFingerprint = ""; });
    }, 300);
  }

  function applyStyle(value) {
    if (!context.check()) return;
    captionStyle = CaptionStyle.normalize(value);
    host.style.setProperty("--caption-font", captionStyle.fontSize + "px");
    host.style.setProperty("--caption-width", captionStyle.maxWidth + "%");
    render(latest);
  }
  context.call(() => chrome.storage.local.get({ captionStyle: CaptionStyle.defaults }))
    .then(saved => applyStyle(saved.captionStyle)).catch(error => note(error.message));
  function onStyleChange(changes, area) {
    if (area === "local" && changes.captionStyle) applyStyle(changes.captionStyle.newValue);
  }
  context.call(() => chrome.storage.onChanged.addListener(onStyleChange)).catch(error => note(error.message));

  function note(text, temporary = false) {
    clearTimeout(badgeTimer);
    if (context.invalidated) { text = CaptionContext.notice; temporary = false; }
    badge.textContent = text;
    badge.hidden = !text;
    if (temporary) badgeTimer = setTimeout(() => { badge.hidden = true; }, 3500);
  }

  function mount() {
    if (!context.check()) return;
    const player = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
    if (player && host.parentElement !== player) player.append(host);
    if (view.wanted && view.sourceKind === "page" && capturedVideo && capturedVideo !== videoElement()) {
      void ensureCapture(view.sessionId).catch(() => {});
    }
  }

  function render(text) {
    const width = host.parentElement?.clientWidth || innerWidth;
    const fontSize = captionStyle.fontSize;
    const limit = Math.max(16, Math.floor((width * captionStyle.maxWidth / 100 - 24) / (fontSize * 0.59)) * 2 - 6);
    let visible = text;
    if (visible.length > limit) visible = "… " + visible.slice(-limit).replace(/^\S*\s/, "");
    if (caption.textContent !== visible) caption.textContent = visible;
    caption.hidden = !visible;
  }

  function releaseCapture() {
    const oldPeer = peer, oldStream = captured;
    clearTimeout(retryTimer);
    retryTimer = null;
    captureEvents?.abort();
    captureEvents = null;
    peer = captured = capturedVideo = capturedSession = null;
    if (oldPeer) oldPeer.onconnectionstatechange = null;
    oldPeer?.close();
    oldStream?.getTracks().forEach(track => track.stop());
  }

  function applyState(state) {
    if (!context.check()) return;
    if (state.sequence != null && state.sequence < lastSequence) return;
    if (state.sequence != null) lastSequence = state.sequence;
    view = { ...view, ...state };
    if (state.viewerTabId != null) viewerTabId = state.viewerTabId;
    toggle.classList.toggle("on", view.wanted);
    toggle.setAttribute("aria-pressed", String(Boolean(view.wanted)));
    toggle.textContent = view.wanted ? "■ 자막 중지" : "CC · 영어 자막";
    if (view.wanted) {
      if (state.lastCaption === null) latest = "";
      if (view.lastCaption) {
        latest = view.lastCaption.text;
        caption.classList.toggle("final", Boolean(view.lastCaption.final));
      }
      if (view.translationWarning) note(view.translationWarning);
      else if (view.status === "listening") note("EN · " + (view.engine === "local" ? "로컬" :
        (view.engine === "factchat" ? "Soniox" : "Gemini") +
        (view.profileApplied && view.profile ? " · " + view.profile.name : "")), true);
      else note(view.error || "영어 자막 연결 중…");
      if (view.sourceKind === "page" && view.needsPageAudio) void ensureCapture(view.sessionId, view.status === "reconnecting").catch(() => {});
    } else {
      releaseCapture();
      latest = "";
      note(view.error || "");
    }
    mount();
    render(latest);
    screenText.setState(view);
  }

  async function sync() {
    if (!context.check() || syncing) return;
    syncing = true;
    const before = revision;
    try {
      const state = await send("STATE");
      if (state?.error && !state.status) throw new Error(state.error);
      viewerTabId = state.viewerTabId;
      if (before !== revision) return;
      if (state.tabId != null && state.tabId !== viewerTabId) {
        applyState({ wanted: false, status: "idle", error: "", lastCaption: null,
          preferredEngine: state.preferredEngine, viewerTabId });
      } else applyState(state);
      if (view.wanted) {
        await send("RESUME");
        if (view.sourceKind === "page") await ensureCapture(view.sessionId);
      }
    } catch (error) {
      note(error.message);
    } finally { syncing = false; }
  }

  function gatherIce(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", changed);
        if (error) reject(error); else resolve();
      };
      const changed = () => { if (pc.iceGatheringState === "complete") finish(); };
      const timer = setTimeout(() => finish(new Error("오디오 연결 준비 시간이 초과됐습니다.")), 5000);
      pc.addEventListener("icegatheringstatechange", changed);
    });
  }

  function retryCapture(sessionId = view.sessionId) {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!context.check() || !view.wanted || view.sourceKind !== "page" || view.sessionId !== sessionId) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!context.check() || !view.wanted || view.sessionId !== sessionId) return;
      void ensureCapture(sessionId, true).catch(() => {});
    }, 1500);
  }

  function ensureCapture(sessionId, force = false) {
    if (!context.check()) return Promise.reject(new Error(CaptionContext.notice));
    if (captureTask) return captureTask;
    const video = videoElement();
    if (!force && peer && capturedSession === sessionId && capturedVideo === video &&
        !["closed", "failed", "disconnected"].includes(peer.connectionState) &&
        peer.getSenders().some(sender => sender.track?.readyState === "live")) return Promise.resolve({ ok: true });
    captureTask = (async () => {
      lastCaptureAttempt = Date.now();
      releaseCapture();
      if (!video || video.readyState < 2) throw new Error("유튜브 영상을 재생하면 오디오가 연결됩니다.");
      if (!video.captureStream) throw new Error("이 브라우저에서는 확장 아이콘에서 자막을 시작해 주세요.");
      // Forward only the media element's audio. Native WebRTC carries it to the
      // offscreen document even when background page timers are throttled.
      const stream = video.srcObject instanceof MediaStream ?
        new MediaStream(video.srcObject.getAudioTracks().map(track => track.clone())) : video.captureStream();
      stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
      if (!stream.getAudioTracks().length) throw new Error("영상 오디오를 찾지 못했습니다. 영상을 재생해 주세요.");
      const pc = new RTCPeerConnection({ iceServers: [] });
      peer = pc;
      captured = stream;
      capturedVideo = video;
      capturedSession = sessionId;
      captureEvents = new AbortController();
      const valid = () => context.check() && peer === pc && capturedSession === sessionId;
      const retryThisCapture = () => { if (valid()) retryCapture(sessionId); };
      stream.getAudioTracks().forEach(track => {
        pc.addTrack(track, stream);
        track.addEventListener("ended", retryThisCapture, { once: true, signal: captureEvents.signal });
      });
      stream.addEventListener("removetrack", event => {
        if (event.track.kind === "audio") retryThisCapture();
      }, { signal: captureEvents.signal });
      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected"].includes(pc.connectionState)) retryThisCapture();
      };
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await gatherIce(pc);
        if (!valid()) throw new Error("이전 캡처 요청이 취소됐습니다.");
        const result = await send("PAGE_OFFER", { sessionId, offer: pc.localDescription.toJSON() });
        if (result?.error) throw new Error(result.error);
        if (!valid()) throw new Error("이전 캡처 요청이 취소됐습니다.");
        await pc.setRemoteDescription(result.answer);
        return { ok: true };
      } catch (error) {
        if (valid()) releaseCapture();
        throw error;
      }
    })().catch(error => {
      if (context.check() && view.wanted && view.sessionId === sessionId) { note(error.message); retryCapture(sessionId); }
      throw error;
    }).finally(() => { captureTask = null; });
    return captureTask;
  }

  toggle.addEventListener("click", async event => {
    event.stopPropagation();
    if (!context.check()) { location.reload(); return; }
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    if (!view.wanted) note("서버와 영어 자막을 연결하고 있습니다…");
    try {
      const result = await send(view.wanted ? "STOP" : "START", { source: "page" });
      if (result?.error) throw new Error(result.error);
      applyState(result);
    } catch (error) { note(error.message); }
    finally { busy = false; toggle.disabled = false; }
  });

  settings.addEventListener("click", async event => {
    event.stopPropagation();
    if (!context.check()) return;
    try {
      const opening = panel.hidden;
      if (opening && viewerTabId == null) await sync();
      if (!context.check()) return;
      if (opening && viewerTabId == null) { note("유튜브 페이지를 한 번 새로고침해 주세요."); return; }
      if (!frame) {
        const url = await context.call(() => chrome.runtime.getURL("popup.html"));
        frame = document.createElement("iframe");
        frame.title = "Live English Captions 설정";
        frame.src = url + "?tabId=" + viewerTabId;
        panel.append(frame);
      }
      panel.hidden = !opening;
      settings.setAttribute("aria-expanded", String(opening));
      screenText.layout();
    } catch (error) {
      note(error.message);
    }
  });
  shadow.querySelector(".close").addEventListener("click", () => {
    panel.hidden = true;
    settings.setAttribute("aria-expanded", "false");
    settings.focus();
    screenText.layout();
  });
  // Prevent player shortcuts and click-to-pause from consuming our controls.
  for (const type of ["click", "dblclick", "keydown", "keyup", "pointerdown"]) {
    shadow.querySelector(".controls").addEventListener(type, event => event.stopPropagation());
    panel.addEventListener(type, event => event.stopPropagation());
  }

  mutationObserver = new MutationObserver(() => {
    if (mountQueued) return;
    mountQueued = true;
    queueMicrotask(() => { mountQueued = false; mount(); });
    scheduleChannel();
  });
  resizeObserver = new ResizeObserver(() => { render(latest); screenText.layout(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); }, { signal: events.signal });
  window.addEventListener("pageshow", () => { void sync(); }, { signal: events.signal });
  document.addEventListener("yt-navigate-start", () => { navigating = true; screenText.invalidate(); }, { signal: events.signal });
  document.addEventListener("yt-navigate-finish", () => {
    navigating = false;
    channelFingerprint = "";
    mount();
    scheduleChannel();
    void sync();
  }, { signal: events.signal });
  for (const type of ["loadeddata", "playing"]) {
    document.addEventListener(type, event => {
      if (event.target?.tagName === "VIDEO" && view.wanted && view.sourceKind === "page" &&
          Date.now() - lastCaptureAttempt > 1000) void ensureCapture(view.sessionId).catch(() => {});
    }, { capture: true, signal: events.signal });
  }
  document.addEventListener("emptied", event => {
    if (!context.check() || event.target !== capturedVideo || !view.wanted || view.sourceKind !== "page") return;
    // Chromium may retain a live sender while the element has already replaced its source.
    releaseCapture();
    retryCapture(view.sessionId);
  }, { capture: true, signal: events.signal });
  function onMessage(message, sender, reply) {
    if (!context.check() || message.target !== "captions" || sender.id !== chrome.runtime.id) return;
    if (message.type === "CHANNEL_INFO") { reply(channelInfo()); return; }
    if (message.type === "CAPTURE") {
      const respond = value => context.call(() => reply(value)).catch(error => note(error.message));
      ensureCapture(message.sessionId).then(respond, error => respond({ error: error.message }));
      return true;
    }
    if (message.type === "state") { revision++; applyState(message); }
    else if (message.type === "transcript" && view.wanted && message.sessionId === view.sessionId) {
      if (message.sequence < lastSequence) return;
      lastSequence = message.sequence;
      revision++;
      latest = message.text;
      view.lastCaption = message;
      caption.classList.toggle("final", Boolean(message.final));
      render(latest);
      screenText.layout();
    }
  }
  context.call(() => chrome.runtime.onMessage.addListener(onMessage)).catch(error => note(error.message));
  if (!context.check()) return;
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  resizeObserver.observe(host);
  contextTimer = setInterval(() => context.check(), 1500);
  mount();
  applyStyle(captionStyle);
  scheduleChannel();
  void sync();
})();
