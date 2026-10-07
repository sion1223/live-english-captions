# 방송별 자막 프로필

설정일: 2026-09-26. YouTube에서 공개 영어 자동 자막을 직접 추출했다.
YouTube Summary 확장은 사용하지 않았다. 원문 자막은 분석용 임시 폴더에만 두며,
실시간 인식에는 검토한 용어 목록만 전달한다.

| 채널 | 공식 채널 ID | 참고 방송 | 용어 수 |
| --- | --- | ---: | ---: |
| [Saba](https://www.youtube.com/@SamekoSaba) | UCxsZ6NCzjU_t4YSxQLBcM5A | 3 | 26 |
| [Cecilia Immergreen](https://www.youtube.com/@holoen_ceciliaimmergreen) | UCvN5h1ShZtc7nly3pezRayg | 2 | 30 |

자동 선택은 현재 재생 영상의 소유자 링크가 채널 ID 또는 핸들과 일치할 때만 한다.
제목에 이름이 등장하는 영상이나 팬 클립 채널에는 적용하지 않는다.
YouTube 안에서 다른 채널로 이동하면 프로필을 바꾸거나 기본 인식으로 돌아간다.

## Saba

- [데뷔 방송](https://www.youtube.com/watch?v=pYVEIX7nSEs): 자동 자막 1,382구간, 36,547자.
- [YAPYAP 방송](https://www.youtube.com/watch?v=cqexC_KlAnw): 4,965구간, 116,268자.
- [Hytale 방송](https://www.youtube.com/watch?v=kIsRYLvylXk): 3,322구간, 85,790자.

본명 표기와 인사, 협업자, 게임 이름을 중심으로 정리했다. 예: Sameko Saba, Yoho,
Sabart, Dooby, Limealicious, Henya the Genius, Hytale, YAPYAP, GoldenEye, Sabaton.
협업자 표기는 Saba 본인의 영상 설명에 있는 채널 태그로 확인했다.
팬 이름 Kaniki는 [공개 프로필](https://hololist.net/sameko-saba/)로 보완했다.

## Cecilia Immergreen

- [데뷔 방송](https://www.youtube.com/watch?v=p_ZQs-kgUKI): 자동 자막 803구간, 25,358자.
- [Stranger Things 이야기 방송](https://www.youtube.com/watch?v=_EXIVk54450): 2,144구간, 70,345자.

자동 자막에 나타나는 Cecilia Immigrine, Hol Life, Code Guess, Dungeon Meshy 등의
표기를 그대로 사전에 넣지 않았다. Cecilia Immergreen, hololive, Code Geass,
Dungeon Meshi처럼 확인한 표기를 힌트로 전달한다.
Otomo, Justice 동료 이름 등은 아래 공식 자료로 보완했다.

- [Cecilia 공식 소개](https://hololive.hololivepro.com/en/talents/cecilia-immergreen/)
- [Justice 공식 소개](https://hololive.hololivepro.com/en/special/12260/)
- [1주년 공식 상품 안내: Otomo](https://shop.hololivepro.com/en/products/ceciliaimmergreen_anniversary_1st)
- [공식 상품 목록: CCGG·Autofister](https://shop.hololivepro.com/en/collections/ceciliaimmergreen)

## 적용 방식

Gemini 연결을 시작할 때 `inputAudioTranscription.customVocabulary`에 선택된
채널의 용어를 보낸다. 연결 복구 시에도 같은 목록을 다시 적용한다.
채널이 바뀌면 캡처를 유지하면서 Gemini 세션을 새 프로필로 다시 연결한다.
자막 문장을 매번 추가 API로 교정하지 않으며, 출력 단어를 강제로 치환하지도 않는다.

전체 설정은 `extension/channel-profiles.json`, 용어별 자막·설명 출현 횟수와
검토한 오인식 표기는 `reports/channel-profile-evidence.json`에 있다.

이 프로필은 어휘 인식 힌트다. 음성·억양 학습이나 정확도 향상을 보장하는 학습 모델이 아니다.
방송별 인식 정확도 개선 폭은 별도 측정하지 않았다.

검증: 두 프로필 모두 실제 Gemini 연결에서 용어 설정이 수락됐다(검증 중 음성 전송 없음).
격리된 Chromium 브라우저에서 자동 채널 전환과 기본 인식 복귀를 확인했고,
실제 공개 YouTube 페이지에서도 Cecilia의 채널 소유자 링크를 확인했다.
