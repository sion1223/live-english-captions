# Live English Captions

YouTube 음성과 영상 속 외국어를 영어로 표시하는 Windows용 Chrome/Edge 확장입니다.
FactChat(BAZE) 게이트웨이의 Soniox 실시간 받아쓰기와 Gemini 번역을 지원합니다.
입력 언어는 자동 감지하며 출력은 영어로 고정합니다. 영어 음성은 영어 자막으로 표시합니다.
지원 언어와 인식 품질은 선택한 받아쓰기 모델에 따라 다릅니다.

## 실행

1. 최초 설치 또는 폴더 위치를 옮긴 경우 `setup.ps1`을 한 번 실행합니다.
2. `chrome://extensions` 또는 `edge://extensions`에서 개발자 모드를 켜고 `extension` 폴더를 로드합니다.
3. YouTube 영상의 **CC · 영어 자막**을 누릅니다. 서버가 꺼져 있으면 자동으로 실행됩니다.
4. 처음에는 영상 위 설정 버튼에서 선택한 서비스의 API 키를 한 번 저장합니다. 키 저장도 필요한 서버를 자동 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

**업데이트 적용:** 확장 관리 화면에서 새로고침하고 YouTube 페이지도 한 번 새로고침합니다.
자동 실행 권한(`nativeMessaging`)이 추가되었습니다. 이전 서버가 실행 중이면 `stop.ps1`로 한 번 종료합니다.
매번 `start.cmd`를 실행할 필요는 없습니다. 이 파일은 수동 실행/진단 용도로도 사용할 수 있습니다.
확장 프로그램만 새로고침한 경우 기존 영상 탭의 캡처와 반복 요청을 정리하고 **탭 새로고침** 버튼을 표시합니다.
이 버튼 또는 F5로 영상 탭을 새로고침한 뒤 자막을 다시 시작합니다.

자동 실행 연결은 현재 Windows 사용자 레지스트리의 Chrome/Edge Native Messaging 항목으로 등록됩니다.
관리자 권한이나 Windows 시작 프로그램 등록은 필요 없습니다. 폴더를 옮기면 `setup.ps1`을 다시 실행합니다.

## 영상 속 글자

영상 위 **화면 번역 ON/OFF** 버튼 또는 설정의 **화면 글자 영어 번역**으로 켜고 끕니다.
새 설치 기본값은 꺼짐이며 기존에 직접 저장한 선택은 유지합니다. 받아쓰기와 별도로 켜고 끌 수 있습니다.
FactChat에서는 공용 API 키를, Google 직접 연결에서는 화면 번역 전용 키를 저장한 뒤 사용합니다. 음성 자막을 시작해야 화면 번역도 실행됩니다.
기본 간격은 3초이며 2초/3초/5초/10초 중 선택할 수 있습니다.

- 영상 프레임의 비영어 문구를 찾아 영어를 원문 옆에 표시합니다. 영어 문구와 숫자만 있는 항목은 제외합니다.
- 원문 영역과 번역문에 같은 색 테두리와 번호를 표시합니다. 일부 문구가 사라져도 남은 문구의 번호와 색은 유지됩니다.
- 오른쪽 공간이 없으면 왼쪽, 아래, 위와 주변 빈 공간을 확인합니다. 원문, 다른 번역, 자막, 설정창을 가리지 않도록 배치하며 공간이 부족하면 해당 쌍을 숨깁니다.
- 작은 압축 노이즈는 건너뛰고, 화면 전체와 작은 영역의 변화를 함께 검사합니다. 한 번에 한 요청만 처리하며 쌓아두지 않습니다.
- 번역할 글자가 계속 없으면 간격을 6초→12초→최대 15초로 늘립니다(기본 3초 기준).
  큰 장면 변화나 글자 크기의 뚜렷한 국소 변화는 기본 간격으로 복귀합니다.
  이 절약 구간에서 변화 감지 기준을 넘지 못한 작은 글자는 확인이 최대 15초 늦어질 수 있습니다.
- 동일 입력은 서버 메모리에 최대 10분 동안 캐시합니다. 요청·캐시 재사용·토큰·제한 오류 횟수는 `/health`의 `usage`에서 확인합니다.
- Google의 `Retry-After` 헤더와 `RetryInfo.retryDelay`를 읽고 해당 트랙만 대기합니다.
  탐색이나 화면번역 OFF/ON, 음성 재연결로 서버의 대기시간이 초기화되지 않습니다. 일일 한도는 60초로 잘라 재시도하지 않습니다.
- 탐색/장면 변화/탭 전환/중지/설정 해제 시 이전 번역을 제거합니다. 탭이 숨겨져 있는 동안 화면 번역은 쉽니다.
- 영상은 최대 1280×720 JPEG로 줄여 보냅니다. 화면 캡처와 번역 결과는 디스크에 저장하지 않습니다.
- 영상의 보안 설정으로 프레임을 직접 읽을 수 없으면 현재 탭의 화면에서 영상 부분만 잘라 사용합니다.
  이 경우 확장 아이콘에서 시작해야 Chrome의 화면 캡처 권한이 부여되며, 영상 전체가 화면에 보여야 합니다.
- DRM으로 보호된 영상, 작은 글자, 매우 빠르게 바뀌는 장면에서는 번역이 누락될 수 있습니다.

표시되는 **화면 EN · N초**는 해당 프레임의 요청부터 결과 수신까지 실제 걸린 시간입니다.
글자가 처음 등장한 시점부터의 지연에는 화면 확인 간격(기본 최대 3초)이 더해집니다.
API 속도, 글자 수, 네트워크에 따라 달라지므로 항상 일정한 지연을 보장하지 않습니다.

## 키와 실행 상태

키는 `%LOCALAPPDATA%\LiveEnglishCaptions\settings.json`에 저장하며, 이전 `.run/gemini-settings.json`은 자동 이전합니다.
`factchat_api_key`는 FactChat 공용 키입니다. `BAZE_API_KEY` 환경변수도 지원합니다.
`transcription_provider`, `audio_provider`, `screen_provider`를 각각 `factchat`으로 설정하면
받아쓰기, 외국어 문장 번역, 화면 번역이 모두 이 키로 게이트웨이를 사용합니다. 설정 화면에서 이 키를 변경하면 세 기능에 함께 적용됩니다.
`TRANSCRIPTION_PROVIDER`, `CAPTION_TRANSLATION_PROVIDER`, `SCREEN_TRANSLATION_PROVIDER` 환경변수가 파일 설정보다 우선합니다.
FactChat 경유 시 음성은 Soniox로, 번역할 영상 화면과 외국어 문장은 Gemini로 전송되며 BAZE 계정의 크레딧이 사용됩니다.
키는 소스 코드·확장 저장소·YouTube 페이지에 넣지 않습니다. 인증서 검증에는 운영체제의 신뢰 저장소를 사용합니다.

각 제공자를 `google`로 지정하면 기존 Google 직접 연결을 사용할 수 있습니다(미설정 시 기본값).
이때 `api_key`는 받아쓰기와 음성 문장 번역, `screen_api_key`는 화면 전용이며 기존 키를 보존합니다.
음성에는 `GEMINI_API_KEY`와 `GOOGLE_API_KEY`, 화면에는 `GEMINI_SCREEN_API_KEY`도 지원합니다.
Google 화면 키가 없을 때 음성 키를 대신 사용하지 않습니다. 같은 Google 프로젝트의 키들은 사용량 한도를 공유합니다.
FactChat 연결 실패 시 Google 키로 자동 전환하지 않습니다.

팝업을 닫거나 다른 탭으로 이동해도 음성 자막은 계속됩니다. 영상 전체화면, 페이지 새로고침,
플레이어 교체 시에도 오디오와 자막 상태를 복원합니다. 한 번에 한 YouTube 탭을 지원합니다.
영상에서 YouTube 홈이나 검색 화면으로 이동하면 이전 캡처를 종료해 다른 영상의 시작을 막지 않습니다.
오디오 소스가 바뀌면 새 트랙으로 재연결하고, 중지된 세션의 이벤트와 재시도는 제거합니다.
브라우저 종료, PC 절전, 영상 일시정지 중에는 새로운 음성을 처리하지 못합니다.

## 커스텀 용어와 자막 크기

- 원하는 YouTube 채널과 받아쓰기 용어를 직접 설정할 수 있습니다. 기본 제공 채널 프로필은 비어 있습니다.
- `extension/channel-profiles.example.json`을 참고해 `extension/channel-profiles.json`에 채널 핸들 또는 ID와 용어를 등록합니다.
- 영상 소유 채널이 등록한 채널과 일치하면 Soniox 또는 Gemini 음성 인식 세션에 커스텀 용어를 자동 적용합니다.
- 자막 글자 크기 16–42px, 최대 너비 45–95%를 설정하며 변경 사항을 저장합니다.
- 설정 예시와 적용 방법: [커스텀 채널 프로필 안내](reports/channel-profiles.md).

## 내부 구성

- Native Messaging 실행기: `native_host.py`와 `native-host.cmd`. 시작 명령만 허용하며 API 키는 반환하지 않습니다.
- 음성: 영상 audio captureStream → 로컬 WebRTC → offscreen AudioWorklet → 16kHz mono PCM16.
- FactChat 인식: Soniox `stt-rt-v5`, 자동 언어 감지와 커스텀 용어 힌트. 확정 토큰은 누적하고 미확정 부분만 교체하며 발화 경계에서 문장을 확정합니다.
  기존 `gemini-3.5-transcribe-live`는 제공된 FactChat 계정에서 지원하지 않아 Soniox를 사용합니다. Google 직접 연결에서는 기존 Gemini 인식을 유지합니다.
- 음성 문장 영어 번역: `gemini-3.1-flash-lite`. FactChat의 Gemini 네이티브 경로를 지원하며 `GEMINI_CAPTION_TRANSLATION_MODEL`로 모델을 지정합니다.
- 영상 글자 번역: `gemini-3.5-flash-lite`. FactChat의 Gemini 네이티브 경로에서 기존 이미지·JSON 스키마를 그대로 사용합니다. `GEMINI_SCREEN_TRANSLATION_MODEL`로 모델을 지정합니다.
  이전 `GEMINI_TRANSLATION_MODEL` 설정은 화면 트랙에만 적용합니다. 두 트랙을 같은 모델로 지정하면 모델 사용량 한도를 다시 공유합니다.
- 인식 중간 결과는 최신 내용으로 합칩니다. 받아쓰기 모델 또는 Lingua가 영어로 식별한 문장은 추가 번역 없이 표시합니다.
  불확실하거나 언어가 섞인 문장은 Gemini로 번역합니다. 이 요청이나 재시도를 기다리는 동안에도 새 영어 자막은 즉시 전달합니다.
  확정 문장은 추가 대기 없이 번역하고, 미완성 문장은 최초 300ms 동안 합친 뒤 같은 문장에 대해 최대 0.8초마다 번역합니다.
  동일한 중간/확정 문장은 번역을 재사용합니다. 번역 시간 초과·잘못된 응답·인증 오류가 받아쓰기 연결을 재시작하지 않습니다.
  인증·모델 접근 오류는 같은 키로 반복 호출하지 않고 설정 변경을 기다립니다.
- 음성 스트리밍(`/asr`)과 화면 번역(`/screen`)은 별도 연결입니다. 영상 번역, 음성 문장 번역, 언어 판별은 각각 전용 작업 스레드를 사용합니다.
  화면 번역은 원문 위치를 0–1000 좌표로 받아 배치하며, 화면 요청이 느리거나 실패해도 음성 큐를 점유하지 않습니다.
  JPEG 변환은 실제 요청 시에만 실행하고, 변하지 않은 번역 박스는 다시 만들지 않습니다.
  화면 오류/대기는 화면 상태에만 표시하며 음성 트랙의 재시도 상태를 바꾸지 않습니다.
  요청 캐시와 재시도 대기시간은 제공자·모델·키·트랙별로 분리합니다. FactChat 공용 키는 계정 사용량 한도를 공유하며 서비스 장애까지 독립되는 것은 아닙니다.
- 서버 상태: `http://127.0.0.1:8765/health`, 로그: `.run/server.log`, `.run/server-error.log`.
- 과거 로컬 Zipformer 비교 코드는 진단용으로 남아 있지만 확장 설정에서는 선택하지 않습니다.
  로컬 모델은 서버 시작 시 로드하지 않으며, 최초 설치에서 다운로드하지 않습니다.

수동 종료:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
```

## 검증

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --test tests/runtime-context.test.cjs tests/background.test.cjs tests/offscreen.test.cjs tests/screen-budget.test.cjs
node tests/screen-layout.cjs
node tests/browser-smoke.cjs
```

브라우저 검증은 현재 PC의 Playwright 및 Edge로 격리된 프로필을 사용합니다.
합성 YouTube 영상으로 자동 실행, 선택한 제공자의 실제 받아쓰기/화면 번역, 라벨 배치, 설정 저장, 중지를 확인합니다.
자막 실행 중 확장 새로고침, 이전 연결 정리, 영상 탭 새로고침 후 재시작도 확인합니다.
일반 미디어 파일의 captureStream, 소스 교체 후 자막 복구, 홈 이동 후 세션 정리도 검증합니다.
`screen-layout.cjs`는 API 호출 없이 색상, 번호, 데스크톱/모바일 배치, 불필요한 JPEG 변환과 DOM 재생성 방지를 검사합니다.
Python 테스트에는 화면 요청 지연, 음성 번역 재시도, 이전 번역의 역전 도착 중에도 영어 자막이 막히지 않는 검사가 포함됩니다.
화면 모델이 HTTP 429를 반환하는 동안 짧은 영어/외국어 음성 문장을 별도 모델로 요청해 정상 처리하는 검사도 포함됩니다.
기존 서버에 사용 중인 세션이 있으면 `$env:CAPTION_TEST_PORT='8766'`으로 별도 테스트 서버를 사용할 수 있습니다.
선택적으로 `$env:SCREEN_RATE_LIMIT='1'`을 함께 설정하면 화면 모델에만 30초 대기를 강제로 적용하는 브라우저 검사를 실행합니다.
`$env:REAL_YOUTUBE='1'`을 설정하면 마지막에 실제 YouTube 영상의 음성 자막 표시도 확인합니다.
실제 API 키를 사용하므로 소량의 사용량이 발생합니다.
측정 범위와 실제 응답 시간은 [번역 지연 검증](reports/translation-latency.md)에 기록했습니다.
FactChat 전환, 지원 모델 확인, 실제 API와 확장 테스트 결과는 [FactChat 적용 검증](reports/factchat-integration.md)에 기록했습니다.

참고 문서:

- [Gemini 자동 언어 감지](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
- [Google 음성 모델 구분: Live와 Transcribe](https://blog.google/innovation-and-ai/technology/developers-tools/build-real-time-voice-applications-gemini-audio/)
- [Gemini 모델별·프로젝트별 사용량 제한](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini 이미지 이해](https://ai.google.dev/gemini-api/docs/image-understanding)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
