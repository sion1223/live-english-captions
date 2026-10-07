# FactChat 적용 및 검증

확인일: 2026-10-08 (Asia/Seoul)

## 적용 상태

| 기능 | 실제 모델 | 연결 |
|---|---|---|
| 실시간 받아쓰기 | Soniox `stt-rt-v5` | FactChat WebSocket |
| 외국어 문장 → 영어 | `gemini-3.1-flash-lite` | FactChat Gemini 네이티브 API |
| 화면 글자 → 영어 | `gemini-3.5-flash-lite` | FactChat Gemini 네이티브 API |

인증된 `/models/` 조회는 113개 모델을 반환했습니다. 관련 항목으로 `gemini-3.5-flash-lite`,
`gemini-3.1-flash-lite`, `gpt-audio-1.5`, `stt-async-v5`, `gpt-realtime-2.1`, `gemini-3.8-live`를 확인했습니다.

기존 `gemini-3.5-transcribe-live`로 FactChat Gemini Live 연결을 실제 시도했지만,
닫힘 코드 1008과 `Model 'gemini-3.5-transcribe-live' not found` 응답을 받았습니다.
공식 문서의 Soniox 실시간 경로는 같은 키로 연결·전사를 성공했습니다.
GPT Audio 1.5로 받아쓰기를 대체한 것은 아닙니다.

## 검증

- Python 테스트 35개 통과: 토큰 누적/수정, 발화 경계, 영어 직통 표시, 혼합 언어 처리,
  모델/제공자별 캐시, 402/429 처리, 자격 증명 보존, 키 마스킹, 종료 프레임 및 최종 자막 배출.
- JavaScript 테스트 19개 통과: 캡처 상태, 재연결, 화면 번역 제한, 확장 컨텍스트 종료.
- 실제 API: `Bonjour tout le monde.` → `Hello everyone.` (`gemini-3.1-flash-lite`).
- 실제 이미지 API: `게임을 시작합니다` → `Start the game`, 원문 위치 좌표 반환 (`gemini-3.5-flash-lite`).
- 실제 영어 음원 16.715초: Soniox 자막 갱신 73회, 확정 문장 수신, 영어 번역 API 호출 **0회**.
  샘플 스트리밍 시작부터 첫 텍스트까지 약 1.8초였습니다. 한 샘플의 관측치로, 일반적인 지연·정확도 벤치마크가 아닙니다.
- 격리된 브라우저/서버에서 실제 API를 이용한 확장 테스트 통과: 화면 라벨, 영어 자막,
  FactChat/Soniox 상태 표시, 공용 키 안내, 화면 번역 켜기/끄기, 크기 변경, 확장 새로고침,
  캡처 소스 교체, 중지 및 YouTube 홈 이동 시 정리.
- 실제 서버 재시작 후 `/health`에서 버전 `0.6.0`, 위 세 모델과 세 트랙의 `factchat` 선택을 확인했습니다.

## 설정과 반영

키는 기존 사용자별 `%LOCALAPPDATA%\LiveEnglishCaptions\settings.json`의 `factchat_api_key`에 저장했습니다.
이 파일의 `transcription_provider`, `audio_provider`, `screen_provider`는 모두 `factchat`입니다.
기존 Google 키는 보존했으며, 키가 소스·테스트·보고서 파일에 포함되지 않았음을 확인했습니다.
FactChat에서는 한 키를 공유하므로 계정 크레딧/한도도 공유합니다. 코드상의 번역 큐와 재시도는 트랙별로 유지합니다.
TLS 인증서 검증에는 `truststore`를 통해 Windows 신뢰 저장소를 사용합니다.

기존 확장 버전이 보내는 `gemini` 요청도 서버에서 선택된 FactChat 받아쓰기로 연결됩니다.
새 UI 이름과 안내를 반영하려면 사용 중인 Chrome의 **확장 프로그램 관리 → Live English Captions → 새로고침** 후
YouTube 탭을 새로고침합니다. 자동 확장 새로고침은 브라우저 도구의 `chrome://` URL 접근 정책에 의해 차단됐습니다.

## 사용한 공식 문서

- [BAZE 연결 안내](https://docs.factchat.kr/agent-setup/prompt.md)
- [FactChat Gemini 네이티브 API](https://docs.factchat.kr/docs/general/api-gateway/reference/gemini-native)
- [FactChat 실시간 API](https://docs.factchat.kr/docs/general/api-gateway/reference/realtime)
- [Soniox WebSocket API](https://soniox.com/docs/stt/api-reference/websocket-api)
