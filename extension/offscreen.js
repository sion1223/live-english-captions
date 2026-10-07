let current = { status: "idle", tabId: null, wanted: false, error: "", lastCaption: null };
let generation = 0, audioVersion = 0, sequence = 0;
let socket, media, context, worklet, source, peer, remoteSink, reconnectTimer;
let socketReady = false, retry = 0, pendingAudio = [];
let resumeTimer;
const runtimeContext = new CaptionContext(() => {
  clearInterval(resumeTimer);
  void stop().catch(() => {});
});

const snapshot = () => ({ ...current, sequence });
function emit(event) {
  if (!runtimeContext.check()) return;
  runtimeContext.call(() => chrome.runtime.sendMessage({ target: "background", type: "EVENT", tabId: current.tabId,
    event: { ...event, sessionId: current.sessionId, sequence: ++sequence } })).catch(() => {});
}
function setState(status, error = "") {
  current = { ...current, status, error };
  emit({ type: "state", ...snapshot() });
}

async function stop(error = "") {
  generation++;
  audioVersion++;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  pendingAudio = [];
  retry = 0;
  socketReady = false;
  const oldSocket = socket, oldMedia = media, oldContext = context, oldPeer = peer;
  if (remoteSink) { remoteSink.pause(); remoteSink.srcObject = null; remoteSink.remove(); }
  remoteSink = null;
  socket = media = context = worklet = source = peer = null;
  current = { ...current, wanted: false, needsPageAudio: false, lastCaption: null };
  setState(error ? "error" : "idle", error);
  oldSocket?.close();
  oldPeer?.close();
  oldMedia?.getTracks().forEach(track => track.stop());
  if (oldContext) await oldContext.close().catch(() => {});
  return snapshot();
}

function reconnect(run, reason = "연결을 복구하고 있습니다…", retryAfter = 0) {
  if (run !== generation || !current.wanted || reconnectTimer) return;
  const oldSocket = socket;
  socket = null;
  socketReady = false;
  oldSocket?.close();
  setState("reconnecting", reason);
  const delay = Math.max(Math.min(30000, 600 * 2 ** Math.min(retry++, 6)),
    Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (run === generation && current.wanted) connect(run);
  }, delay);
}

async function connect(run) {
  if (run !== generation || !current.wanted) return;
  try {
    const result = await runtimeContext.call(() => chrome.runtime.sendMessage({ target: "background", type: "ENSURE_SERVER" }));
    if (run !== generation || !current.wanted) return;
    if (result?.error) { reconnect(run, result.error); return; }
  } catch (error) { reconnect(run, error.message); return; }
  if (socket) return;
  const ws = new WebSocket("ws://127.0.0.1:8765/asr");
  socket = ws;
  socketReady = false;
  const valid = () => run === generation && socket === ws && current.wanted;
  const timeout = setTimeout(() => { if (valid()) reconnect(run, "응답을 기다리는 중입니다. 자동으로 다시 연결합니다…"); }, 30000);
  ws.onopen = () => {
    if (valid()) ws.send(JSON.stringify({ sample_rate: 16000, format: "pcm_s16le",
      engine: current.engine, profile_id: current.profile?.id || null }));
  };
  ws.onmessage = event => {
    if (!valid()) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.track === "screen") return;
    if (message.type === "ready") {
      clearTimeout(timeout);
      socketReady = true;
      retry = 0;
      current.engine = message.engine || current.engine;
      current.model = message.model;
      current.profileApplied = message.profile_id || null;
      const buffered = pendingAudio;
      pendingAudio = [];
      for (const packet of buffered) ws.send(packet);
      setState(current.needsPageAudio ? "reconnecting" : "listening",
        current.needsPageAudio ? "영상 오디오를 다시 연결하고 있습니다…" : "");
    } else if (message.type === "transcript") {
      if (current.translationWarning) {
        current.translationWarning = "";
        setState(current.status, current.error);
      }
      current.lastCaption = { ...message, updatedAt: Date.now() };
      emit(current.lastCaption);
    } else if (message.type === "translation_status") {
      current.translationWarning = message.message || "음성 영어 번역 요청이 제한되어 대기 중입니다. 받아쓰기는 계속됩니다.";
      setState(current.status, current.error);
    } else if (message.type === "error") {
      clearTimeout(timeout);
      if (message.recoverable) reconnect(run, message.message, message.retry_after);
      else void stop(message.message);
    } else if (message.type === "done") {
      reconnect(run);
    }
  };
  ws.onerror = ws.onclose = () => {
    clearTimeout(timeout);
    if (valid()) reconnect(run, "서버 연결이 끊겨 다시 연결하고 있습니다…");
  };
}

function sendAudio(packet, run) {
  if (run !== generation || !current.wanted) return;
  if (socketReady && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 64000) {
    socket.send(packet);
    return;
  }
  // Retain at most two seconds: a slow reconnect must not create growing caption delay.
  pendingAudio.push(packet);
  if (pendingAudio.length > 50) {
    pendingAudio.shift();
    if (!current.audioGap) {
      current.audioGap = true;
      emit({ type: "state", ...snapshot() });
    }
  }
  if (socketReady) reconnect(run, "전송 지연으로 다시 연결하고 있습니다…");
}

async function attachAudio(captured, run, playback) {
  if (run !== generation || !current.wanted) {
    captured.getTracks().forEach(track => track.stop());
    return;
  }
  const version = ++audioVersion;
  const oldMedia = media;
  worklet?.disconnect();
  source?.disconnect();
  if (worklet) worklet.port.onmessage = null;
  oldMedia?.getTracks().forEach(track => track.stop());
  media = captured;
  if (!context) {
    context = new AudioContext({ latencyHint: "interactive" });
    context.captionModule = context.audioWorklet.addModule("pcm-worklet.js");
  }
  const ac = context;
  await ac.captionModule;
  await ac.resume();
  if (run !== generation || version !== audioVersion) return;
  if (!playback) {
    // Chromium's WebRTC receiver needs a media-element sink to start audio
    // playout into Web Audio. Muting this sink avoids duplicating YouTube audio.
    if (!remoteSink) {
      remoteSink = new Audio();
      remoteSink.muted = true;
      document.body.append(remoteSink);
    }
    remoteSink.srcObject = captured;
    await remoteSink.play();
    if (run !== generation || version !== audioVersion) return;
  }
  source = ac.createMediaStreamSource(captured);
  if (playback) source.connect(ac.destination); // tabCapture mutes the tab; page capture does not.
  worklet = new AudioWorkletNode(ac, "caption-pcm");
  worklet.port.onmessage = event => { if (version === audioVersion) sendAudio(event.data, run); };
  source.connect(worklet);
  worklet.connect(ac.destination); // The worklet outputs silence.
  current.needsPageAudio = false;
  captured.getAudioTracks()[0].onended = () => {
    if (run !== generation || media !== captured || !current.wanted) return;
    if (current.sourceKind === "page") {
      current.needsPageAudio = true;
      setState("reconnecting", "영상 오디오를 다시 연결하고 있습니다…");
    } else void stop("탭의 오디오 캡처가 종료됐습니다. 다시 시작해 주세요.");
  };
  if (!socket && !reconnectTimer) connect(run);
  else if (socketReady) setState("listening");
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

async function pageOffer(message) {
  const run = generation;
  if (!current.wanted || current.sessionId !== message.sessionId) throw new Error("캡처 요청이 취소됐습니다.");
  const pc = new RTCPeerConnection({ iceServers: [] });
  const oldPeer = peer;
  peer = pc;
  oldPeer?.close();
  const valid = () => run === generation && peer === pc && current.wanted;
  pc.ontrack = event => {
    if (!valid()) return;
    const incoming = new MediaStream([event.track]);
    void attachAudio(incoming, run, false).catch(error => { if (valid()) void stop(error.message); });
  };
  pc.onconnectionstatechange = () => {
    if (!valid()) return;
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      current.needsPageAudio = true;
      setState("reconnecting", "영상 오디오를 다시 연결하고 있습니다…");
    } else if (pc.connectionState === "connected") {
      current.needsPageAudio = false;
      if (socketReady) setState("listening");
    }
  };
  try {
    await pc.setRemoteDescription(message.offer);
    await pc.setLocalDescription(await pc.createAnswer());
    await gatherIce(pc);
    if (!valid()) throw new Error("캡처 요청이 취소됐습니다.");
    return { answer: pc.localDescription.toJSON() };
  } catch (error) {
    if (peer === pc) peer = null;
    pc.close();
    throw error;
  }
}

async function start(message) {
  if (current.wanted) return snapshot();
  const run = ++generation;
  current = {
    status: "starting", tabId: message.tabId, engine: message.engine || "gemini",
    profile: message.profile || null, profileApplied: null,
    wanted: true, error: "", sessionId: crypto.randomUUID(), lastCaption: null, audioGap: false,
    sourceKind: message.type === "START_TAB" ? "tab" : "page", needsPageAudio: message.type === "START_PAGE",
  };
  pendingAudio = [];
  retry = 0;
  setState("starting");
  if (message.type === "START_TAB") {
    try {
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: message.streamId } }, video: false,
      });
      await attachAudio(captured, run, true);
    } catch (error) { if (run === generation) await stop(error.message); }
  }
  return snapshot();
}

async function resume() {
  if (!runtimeContext.check()) return snapshot();
  if (current.wanted) {
    if (context?.state === "suspended") await context.resume().catch(() => {});
    if (media && !socket && !reconnectTimer) connect(generation);
  }
  return snapshot();
}

async function setProfile(message) {
  if (!current.wanted || current.sessionId !== message.sessionId) return snapshot();
  if ((current.profile?.id || null) === (message.profile?.id || null)) return snapshot();
  current.profile = message.profile || null;
  current.profileApplied = null;
  current.lastCaption = null;
  if (current.engine !== "local" && (socket || reconnectTimer)) {
    pendingAudio = [];
    reconnect(generation, current.profile ? current.profile.name + " 커스텀 용어 적용 중…" : "기본 자동 인식으로 전환 중…");
  } else setState(current.status, current.error);
  return snapshot();
}
resumeTimer = setInterval(() => { void resume().catch(() => {}); }, 10000);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== "offscreen" || sender.id !== chrome.runtime.id) return;
  if (message.type === "STATE") { reply(snapshot()); return; }
  let operation;
  if (message.type === "START_TAB" || message.type === "START_PAGE") operation = start(message);
  else if (message.type === "PAGE_OFFER") operation = pageOffer(message);
  else if (message.type === "RESUME") operation = resume();
  else if (message.type === "SET_PROFILE") operation = setProfile(message);
  else if (message.type === "STOP" || message.type === "FAIL") operation = stop(message.error);
  else return;
  operation.then(reply).catch(error => reply({ error: error.message }));
  return true;
});
