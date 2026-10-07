const button = document.querySelector("#toggle");
const message = document.querySelector("#message");
const parameters = new URLSearchParams(location.search);
const embedded = parameters.has("tabId");
const tabId = embedded ? Number(parameters.get("tabId")) : undefined;
document.body.classList.toggle("embedded", embedded);
let running = false, busy = false, keyNotice = "";
let refreshTimer;
const context = new CaptionContext(() => {
  clearInterval(refreshTimer);
  message.textContent = CaptionContext.notice;
  document.querySelectorAll("button,input,select").forEach(control => { control.disabled = true; });
});
const send = (type, extra = {}) => context.call(() => chrome.runtime.sendMessage({ target: "background", type, tabId, ...extra }));

async function refresh() {
  if (!context.check() || busy) return;
  try {
    const state = await send("STATE");
    if (busy) return;
    if (state?.error && !state.status) throw new Error(state.error);
    running = Boolean(state.wanted);
    const gatewayAudio = state.providers?.transcription === "factchat";
    const gatewayScreen = state.providers?.screen === "factchat";
    const audioName = gatewayAudio ? "FactChat · Soniox" : "Gemini";
    document.querySelector("#privacy").textContent = gatewayAudio && gatewayScreen ?
      "FactChat을 통해 음성은 Soniox로, 번역할 영상 화면과 외국어 문장은 Gemini로 전송합니다." :
      "음성과 번역할 영상 화면을 선택한 API 서비스로 전송합니다.";
    document.querySelector("#dot").classList.toggle("online", state.online);
    document.querySelector("#engine").textContent = !state.online ? "시작 시 자동 연결" :
      state.geminiConfigured ? audioName + " 준비됨" : audioName + " 키 필요";
    button.disabled = false;
    button.classList.toggle("running", running);
    button.textContent = running ? "자막 중지" : "자막 시작";
    message.textContent = state.error || state.translationWarning || (running ?
      (state.audioGap ? "자막 실행 중 · 재연결 중 일부 음성이 누락됐을 수 있습니다." : "영상 위에 자막을 표시하고 있습니다. 다른 탭으로 이동해도 계속 실행됩니다.") :
      "유튜브 영상을 재생하고 시작하세요.");

    const profile = running ? state.profile : state.detectedProfile;
    document.querySelector("#profile-status").textContent = profile?.name || "언어 자동 인식";
    document.querySelector("#profile-detail").textContent = profile ?
      (running && state.profileApplied === profile.id ? "적용 중" : "자동 선택됨") +
        " · 커스텀 용어 " + profile.vocabularyCount + "개" :
      "원하는 채널과 받아쓰기 용어를 커스텀할 수 있습니다.";

    const saved = state.online && state.geminiConfigured;
    document.querySelector("#key-saved").textContent = saved ? "✓ API 키 저장됨 · 다음 실행에도 자동 사용" :
      state.online ? audioName + " API 키를 한 번 저장해 주세요." : "연결 시 저장된 키를 자동으로 사용합니다.";
    document.querySelector("#key-summary").textContent = saved ? "받아쓰기 API 키 변경" : "받아쓰기 API 키 설정";
    document.querySelector("#api-key").placeholder = saved ? "변경할 때만 새 키 입력" : gatewayAudio ? "FactChat API key (baze_…)" : "Gemini API key";
    document.querySelector("#save-key").textContent = saved ? "새 키로 변경" : "키 저장";
    document.querySelector("#key-status").textContent = keyNotice || (saved ? "저장된 키를 사용 중입니다. 다시 입력할 필요가 없습니다." : "");
    document.querySelector("#screen-key-saved").textContent = !state.online ? "연결 시 화면번역 키를 확인합니다." :
      state.screenConfigured ? (gatewayScreen ? "✓ FactChat API 키 저장됨 · Gemini 화면 번역" :
        state.separateKeys ? "✓ 화면번역 전용 키 저장됨" : "같은 키 사용 중 · 전용 키로 변경해 주세요.") :
      "화면번역 전용 키를 저장해 주세요.";
    document.querySelector("#screen-api-key").placeholder = gatewayScreen ? "FactChat API key (baze_…)" : "화면번역에 사용할 별도 키";
    document.querySelector("#screen-key-detail").textContent = gatewayScreen ?
      "FactChat 키는 받아쓰기와 번역에서 함께 사용합니다. 변경하면 모두 적용됩니다." :
      "같은 Google 프로젝트의 키들은 사용량 한도를 공유합니다.";
    const usage = state.usage?.screen;
    document.querySelector("#screen-usage").textContent = usage ?
      `이번 서버 실행 · 화면 API ${usage.requests}회 · 캐시 재사용 ${usage.cache_hits}회` +
      (usage.retry_after ? ` · ${usage.retry_after}초 후 재개` : usage.blocked ? " · API 키/모델 설정 확인 필요" : "") : "";
  } catch (error) {
    message.textContent = error.message;
    button.disabled = !context.check();
    button.textContent = "다시 확인";
  }
}

button.addEventListener("click", async () => {
  if (!context.check() || busy) return;
  busy = true;
  button.disabled = true;
  button.textContent = running ? "중지 중…" : "연결 중…";
  try {
    const result = await send(running ? "STOP" : "START", { source: embedded ? "page" : "toolbar" });
    if (result?.error) throw new Error(result.error);
    busy = false;
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    button.disabled = !context.check();
    button.textContent = running ? "자막 중지" : "자막 시작";
    setTimeout(() => { busy = false; }, 4000);
  }
});

document.querySelector("#save-key").addEventListener("click", async () => {
  const field = document.querySelector("#api-key");
  const status = document.querySelector("#key-status");
  const save = document.querySelector("#save-key");
  save.disabled = true;
  try {
    if (!field.value.trim()) throw new Error("새 API 키를 입력해 주세요. 기존에 저장된 키는 그대로 유지됩니다.");
    const result = await send("SAVE_KEY", { apiKey: field.value });
    if (result?.error) throw new Error(result.error);
    field.value = "";
    keyNotice = "저장했습니다. 브라우저와 PC를 다시 켜도 자동으로 사용합니다.";
    status.textContent = keyNotice;
    await refresh();
  } catch (error) { keyNotice = error.message; status.textContent = keyNotice; }
  finally { save.disabled = !context.check(); }
});
document.querySelector("#api-key").addEventListener("input", () => { keyNotice = ""; });
document.querySelector("#save-screen-key").addEventListener("click", async () => {
  const field = document.querySelector("#screen-api-key");
  const status = document.querySelector("#screen-key-status");
  const save = document.querySelector("#save-screen-key");
  save.disabled = true;
  try {
    if (!field.value.trim()) throw new Error("화면번역에 사용할 API 키를 입력해 주세요.");
    const result = await send("SAVE_KEY", { apiKey: field.value, track: "screen" });
    if (result?.error) throw new Error(result.error);
    field.value = "";
    status.textContent = "화면번역 API 키를 저장했습니다.";
    await refresh();
  } catch (error) { status.textContent = error.message; }
  finally { save.disabled = !context.check(); }
});
const screenEnabled = document.querySelector("#screen-enabled");
const screenInterval = document.querySelector("#screen-interval");
context.call(() => chrome.storage.local.get({ screenTranslation: false, screenInterval: 3 })).then(saved => {
  screenEnabled.checked = saved.screenTranslation;
  screenInterval.value = String(saved.screenInterval);
  screenInterval.disabled = !saved.screenTranslation;
}).catch(error => { message.textContent = error.message; });
context.call(() => chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.screenTranslation) screenEnabled.checked = Boolean(changes.screenTranslation.newValue);
  if (changes.screenInterval) screenInterval.value = String(changes.screenInterval.newValue);
  screenInterval.disabled = !screenEnabled.checked;
})).catch(error => { message.textContent = error.message; });
let screenSave = Promise.resolve();
async function saveScreen() {
  screenInterval.disabled = !screenEnabled.checked;
  const preference = { enabled: screenEnabled.checked, interval: Number(screenInterval.value) };
  try {
    screenSave = screenSave.catch(() => {}).then(() => send("SCREEN_PREFERENCE", preference));
    const result = await screenSave;
    document.querySelector("#screen-status").textContent = result?.error || "저장됨";
  } catch (error) { document.querySelector("#screen-status").textContent = error.message; }
}
screenEnabled.addEventListener("change", saveScreen);
screenInterval.addEventListener("change", saveScreen);
const fontRange = document.querySelector("#caption-font"), widthRange = document.querySelector("#caption-width");
function showStyle(value) {
  const style = CaptionStyle.normalize(value);
  fontRange.value = style.fontSize;
  widthRange.value = style.maxWidth;
  document.querySelector("#font-value").textContent = style.fontSize + "px";
  document.querySelector("#width-value").textContent = style.maxWidth + "%";
}
context.call(() => chrome.storage.local.get({ captionStyle: CaptionStyle.defaults }))
  .then(saved => showStyle(saved.captionStyle)).catch(error => { message.textContent = error.message; });
let styleSave = Promise.resolve();
function saveStyle() {
  const style = CaptionStyle.normalize({ fontSize: fontRange.value, maxWidth: widthRange.value });
  showStyle(style);
  // Serialize writes so fast slider drags cannot persist an older value last.
  styleSave = styleSave.catch(() => {}).then(async () => {
    const result = await send("CAPTION_STYLE", { style });
    document.querySelector("#style-status").textContent = result?.error || "저장됨";
  }).catch(error => { document.querySelector("#style-status").textContent = error.message; });
}
fontRange.addEventListener("input", saveStyle);
widthRange.addEventListener("input", saveStyle);
document.querySelector("#reset-style").addEventListener("click", () => { showStyle(CaptionStyle.defaults); saveStyle(); });
void refresh();
if (context.check()) refreshTimer = setInterval(refresh, 1500);
