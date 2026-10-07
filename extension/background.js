importScripts("profile-utils.js", "caption-style.js");
const idle = { status: "idle", tabId: null, wanted: false, error: "", lastCaption: null };
let creating, starting, launching;
const screenRequests = new Map();
const profilesReady = fetch(chrome.runtime.getURL("channel-profiles.json")).then(response => response.json()).then(data => data.profiles);
const channelRequests = new Map();

const isYouTube = url => /^https:\/\/(www\.)?youtube\.com\//.test(url || "");
function isVideoPage(url) {
  if (!isYouTube(url)) return false;
  const parsed = new URL(url);
  return (parsed.pathname === "/watch" && Boolean(parsed.searchParams.get("v"))) ||
    /^\/(?:live|shorts)\/[^/]+/.test(parsed.pathname);
}
const offscreen = (type, extra = {}) => chrome.runtime.sendMessage({ target: "offscreen", type, ...extra });

async function channelInfo(tabId) {
  if (tabId == null) return {};
  return await chrome.tabs.sendMessage(tabId, { target: "captions", type: "CHANNEL_INFO" }).catch(() => ({})) || {};
}

async function selectedProfile(tabId) {
  const [profiles, channel] = await Promise.all([profilesReady, channelInfo(tabId)]);
  return CaptionProfiles.summary(CaptionProfiles.select(profiles, channel));
}

async function updateChannel(tabId) {
  const request = (channelRequests.get(tabId) || 0) + 1;
  channelRequests.set(tabId, request);
  const [profile, current] = await Promise.all([selectedProfile(tabId), state()]);
  if (channelRequests.get(tabId) !== request) return { ok: true };
  if (current.wanted && current.tabId === tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!isVideoPage(tab?.url)) return stop();
    return offscreen("SET_PROFILE", { profile, sessionId: current.sessionId });
  }
  return { ok: true };
}

async function hasOffscreen() {
  return (await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  })).length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["USER_MEDIA", "WEB_RTC"],
      justification: "Keep YouTube audio transcription running while its tab is in the background.",
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function state() {
  return await hasOffscreen() ? await offscreen("STATE") || { ...idle } : { ...idle };
}

async function serverOnline() {
  try {
    const response = await fetch("http://127.0.0.1:8765/health", { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    return health.app === "live-english-captions" ? health : null;
  } catch { return null; }
}

async function ensureServer() {
  const health = await serverOnline();
  if (health?.protocol_version >= 5) return health;
  if (health) throw new Error("이전 서버가 실행 중입니다. stop.ps1로 한 번 종료한 뒤 다시 시작해 주세요.");
  if (!launching) {
    launching = chrome.runtime.sendNativeMessage("com.live_english_captions.launcher", { action: "ensure_server" })
      .catch(() => { throw new Error("자동 실행 연결이 필요합니다. setup.ps1을 한 번 실행하고 확장 프로그램을 새로고침해 주세요."); })
      .then(result => {
        if (!result?.ok) throw new Error(result?.error || "서버 자동 실행에 실패했습니다.");
        return result.health;
      }).finally(() => { launching = null; });
  }
  return launching;
}

async function protectTab(tab) {
  await chrome.storage.session.set({ captureTab: { id: tab.id, autoDiscardable: tab.autoDiscardable !== false } });
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
}

async function releaseTab() {
  const { captureTab } = await chrome.storage.session.get("captureTab");
  if (!captureTab) return;
  await chrome.tabs.update(captureTab.id, { autoDiscardable: captureTab.autoDiscardable }).catch(() => {});
  await chrome.storage.session.remove("captureTab");
}

function saveKey(apiKey, track = "audio") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:8765/settings");
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error); else resolve({ ok: true });
    };
    const timeout = setTimeout(() => finish(new Error("로컬 서버에 연결할 수 없습니다.")), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ api_key: apiKey, track }));
    ws.onmessage = event => {
      try {
        const response = JSON.parse(event.data);
        finish(response.type === "saved" ? null : new Error(response.message || "키 저장 실패"));
      } catch { finish(new Error("키 저장 응답을 확인할 수 없습니다.")); }
    };
    ws.onerror = ws.onclose = () => finish(new Error("키를 저장하지 못했습니다. 다시 시도해 주세요."));
  });
}

async function stop() {
  const result = await hasOffscreen() ? await offscreen("STOP") : { ...idle };
  await releaseTab();
  return result;
}

async function start(message, sender) {
  const id = sender.tab?.id ?? message.tabId;
  const tab = id != null ? await chrome.tabs.get(id) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !isVideoPage(tab.url)) throw new Error("유튜브 영상을 연 탭에서 시작해 주세요.");
  const current = await state();
  if (current.wanted) {
    if (current.tabId === tab.id) return current;
    const previousTab = await chrome.tabs.get(current.tabId).catch(() => null);
    if (isVideoPage(previousTab?.url)) {
      throw new Error("다른 유튜브 탭에서 자막이 실행 중입니다. 그 탭에서 먼저 중지해 주세요.");
    }
    await stop();
  }
  const health = await ensureServer();
  const engine = health.transcription_engine || "gemini";
  if (!(health.transcription_configured ?? health.gemini_configured)) throw new Error("영상 위의 설정 버튼에서 받아쓰기 API 키를 한 번 저장해 주세요.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["runtime-context.js", "caption-style.js", "screen-text.js", "content.js"] });
  const profile = await selectedProfile(tab.id);
  await ensureOffscreen();
  await protectTab(tab);
  try {
    // Only an actual toolbar invocation grants tabCapture's activeTab permission.
    if (message.source === "toolbar" && !sender.tab) {
      let streamId;
      try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }); } catch { /* Use the page's media stream below. */ }
      if (streamId) {
        const result = await offscreen("START_TAB", { tabId: tab.id, streamId, engine, profile });
        if (result.error) throw new Error(result.error);
        return result;
      }
    }
    const prepared = await offscreen("START_PAGE", { tabId: tab.id, engine, profile });
    if (prepared.error) throw new Error(prepared.error);
    const result = await chrome.tabs.sendMessage(tab.id, {
      target: "captions", type: "CAPTURE", sessionId: prepared.sessionId,
    });
    if (result?.error) throw new Error(result.error);
    return await state();
  } catch (error) {
    await offscreen("FAIL", { error: error.message });
    await releaseTab();
    throw error;
  }
}

function screenTranslation(image) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:8765/screen");
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("화면 번역 응답이 늦어지고 있습니다.")), 20000);
    ws.onopen = () => ws.send(JSON.stringify({ image }));
    ws.onmessage = event => {
      try {
        const result = JSON.parse(event.data);
        const error = result.type === "screen" ? null : new Error(result.retry_after ?
          "화면 번역만 대기 중 · 음성 자막은 계속됩니다." : result.message || "화면 번역 실패");
        if (error) error.retryAfter = result.retry_after;
        finish(error, result);
      } catch { finish(new Error("화면 번역 응답을 읽지 못했습니다.")); }
    };
    ws.onerror = ws.onclose = () => finish(new Error("화면 번역 서버에 연결할 수 없습니다."));
  });
}

async function translateFrame(message, sender) {
  const tabId = sender.tab?.id;
  const current = await state();
  const preference = await chrome.storage.local.get({ screenTranslation: false });
  if (!preference.screenTranslation || !current.wanted || current.tabId !== tabId || current.sessionId !== message.sessionId) {
    throw new Error("화면 번역 요청이 취소됐습니다.");
  }
  const previous = screenRequests.get(tabId);
  if (previous?.pending || Date.now() - (previous?.at || 0) < 1800) throw new Error("화면 번역 대기 중입니다.");
  const request = { pending: true, at: Date.now() };
  screenRequests.set(tabId, request);
  try {
    // Frames come only from the session's YouTube video, never a whole desktop.
    if (typeof message.image !== "string" || !message.image.startsWith("data:image/jpeg;base64,") || message.image.length > 1800000) {
      throw new Error("영상 화면을 읽을 수 없습니다.");
    }
    return await screenTranslation(message.image);
  } finally { request.pending = false; }
}

async function captureFrame(message, sender) {
  const current = await state();
  const preference = await chrome.storage.local.get({ screenTranslation: false });
  if (!preference.screenTranslation || !current.wanted || current.tabId !== sender.tab?.id || current.sessionId !== message.sessionId) {
    throw new Error("화면 캡처 요청이 취소됐습니다.");
  }
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!tab.active) throw new Error("영상 탭을 보고 있을 때 화면 번역을 계속합니다.");
  const rect = message.rect;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, rect.viewportWidth, rect.viewportHeight].every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.viewportWidth <= 0 || rect.viewportHeight <= 0 ||
      rect.x + rect.width > rect.viewportWidth + 1 || rect.y + rect.height > rect.viewportHeight + 1) {
    throw new Error("영상 전체가 화면에 보이도록 해 주세요.");
  }
  let screenshot;
  try { screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 }); }
  catch { throw new Error("확장 아이콘에서 자막을 시작하면 이 영상의 화면 번역을 사용할 수 있습니다."); }
  const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (active?.id !== tab.id) throw new Error("영상 탭을 보고 있을 때 화면 번역을 계속합니다.");
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    const scaleX = bitmap.width / rect.viewportWidth, scaleY = bitmap.height / rect.viewportHeight;
    const scale = Math.min(1, 1280 / (rect.width * scaleX), 720 / (rect.height * scaleY));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(rect.width * scaleX * scale)), Math.max(1, Math.round(rect.height * scaleY * scale)));
    canvas.getContext("2d").drawImage(bitmap, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX, rect.height * scaleY, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { image: "data:image/jpeg;base64," + btoa(binary) };
  } finally { bitmap.close(); }
}

async function handle(message, sender) {
  const trusted = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (!trusted && !isYouTube(sender.url)) throw new Error("지원하지 않는 페이지입니다.");
  if (message.type === "SCREEN_FRAME" && sender.tab) return translateFrame(message, sender);
  if (message.type === "CAPTURE_FRAME" && sender.tab) return captureFrame(message, sender);
  if (message.type === "ENSURE_SERVER" && sender.url === chrome.runtime.getURL("offscreen.html")) return ensureServer();
  if (message.type === "STATE") {
    const viewerTabId = sender.tab?.id ?? message.tabId ??
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
    const [current, health] = await Promise.all([
      state(), serverOnline(),
    ]);
    const detectedProfile = await selectedProfile(viewerTabId);
    return { ...current, viewerTabId, detectedProfile,
      online: Boolean(health), geminiConfigured: Boolean(health?.gemini_configured),
      screenConfigured: Boolean(health?.screen_configured), separateKeys: Boolean(health?.separate_keys),
      providers: health?.providers, transcriptionModel: health?.transcription_model,
      usage: health?.usage,
      preferredEngine: health?.transcription_engine || "gemini" };
  }
  if (message.type === "CHANNEL_CHANGED" && sender.tab) return updateChannel(sender.tab.id);
  if (message.type === "SCREEN_TOGGLE" && sender.tab) {
    await chrome.storage.local.set({ screenTranslation: Boolean(message.enabled) });
    return { ok: true };
  }
  if (message.type === "CAPTION_STYLE") {
    if (!trusted) throw new Error("확장 프로그램 설정 화면에서 변경해 주세요.");
    const captionStyle = CaptionStyle.normalize(message.style);
    await chrome.storage.local.set({ captionStyle });
    return { captionStyle };
  }
  if (message.type === "SAVE_KEY" || message.type === "SCREEN_PREFERENCE") {
    if (!trusted) throw new Error("확장 프로그램 설정 화면에서 변경해 주세요.");
    if (message.type === "SAVE_KEY") {
      await ensureServer();
      const result = await saveKey(message.apiKey, message.track || "audio");
      if (message.track === "screen") await chrome.storage.local.set({ screenKeyRevision: Date.now() });
      return result;
    }
    await chrome.storage.local.set({ screenTranslation: Boolean(message.enabled),
      screenInterval: [2, 3, 5, 10].includes(message.interval) ? message.interval : 3 });
    return { ok: true };
  }
  if (message.type === "STOP" || message.type === "RESUME" || message.type === "PAGE_OFFER") {
    const current = await state();
    if (sender.tab && sender.tab.id !== current.tabId) throw new Error("이 탭에서 실행 중인 자막이 없습니다.");
    if (message.type === "STOP") return stop();
    if (message.type === "RESUME") return current.wanted ? offscreen("RESUME") : current;
    if (!current.wanted || current.sessionId !== message.sessionId) throw new Error("이전 캡처 요청이 취소됐습니다.");
    return offscreen("PAGE_OFFER", { sessionId: message.sessionId, offer: message.offer });
  }
  if (message.type === "START") {
    if (starting) throw new Error("자막 연결 중입니다. 잠시 기다려 주세요.");
    starting = start(message, sender);
    try { return await starting; } finally { starting = null; }
  }
  if (message.type === "EVENT" && sender.url === chrome.runtime.getURL("offscreen.html")) {
    if (message.event.type === "state") {
      const status = message.event.status;
      await chrome.action.setBadgeText({ text: status === "listening" ? "ON" : message.event.wanted ? "..." : status === "error" ? "!" : "" });
      await chrome.action.setBadgeBackgroundColor({ color: status === "error" ? "#d85252" : "#275238" });
      // Ignore late idle events if a new session has already started.
      if (!message.event.wanted && !(await state()).wanted && !starting) await releaseTab();
    }
    if (message.tabId != null) {
      await chrome.tabs.sendMessage(message.tabId, { target: "captions", ...message.event }).catch(() => {});
    }
    return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== "background" || sender.id !== chrome.runtime.id) return;
  handle(message, sender).then(reply).catch(error => reply({ error: error.message, retryAfter: error.retryAfter }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  channelRequests.delete(tabId);
  screenRequests.delete(tabId);
  if ((await state()).tabId === tabId) await stop();
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  // Reloads, tab switches and minimizing must not stop an ongoing session.
  // Outside our host permission Chrome may omit the destination URL entirely.
  const leftVideo = (change.url && !isVideoPage(change.url)) ||
    (change.status === "complete" && !isVideoPage(tab.url));
  if (leftVideo && (await state()).tabId === tabId) await stop();
});
