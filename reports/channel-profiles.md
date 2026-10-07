# 커스텀 채널 프로필

원하는 YouTube 채널과 받아쓰기 용어를 직접 설정할 수 있습니다.
기본 설정은 비어 있으며, 등록하지 않은 채널에서는 언어 자동 인식으로 동작합니다.

## 설정

설치 폴더의 `extension/channel-profiles.json`을 편집합니다.
`extension/channel-profiles.example.json`에 다음과 같은 예시가 있습니다.
예시 파일 자체는 자동으로 적용되지 않습니다.

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "my-channel",
      "name": "내 채널",
      "handles": ["YourChannelHandle"],
      "vocabulary": ["Star Harbor", "Moon Crystal"]
    }
  ]
}
```

- `id`: 각 프로필을 구분하는 고유한 이름입니다.
- `name`: 확장 프로그램에 표시할 이름입니다.
- `handles`: 실제 YouTube 채널 핸들을 `@` 없이 입력합니다.
- `channelId`: 채널 ID로도 연결하려면 이 항목에 실제 `UC…` ID를 추가합니다. 핸들과 ID 중 하나 이상을 지정하세요.
- `vocabulary`: 인식에 참고할 고유명사, 게임 이름, 전문 용어 등을 입력합니다. 1–100개, 각 80자 이하이며 줄바꿈과 대소문자만 다른 중복은 허용하지 않습니다.

채널을 추가하려면 `profiles` 배열에 항목을 더 넣습니다.
모든 커스텀 용어를 해제하려면 `profiles`를 빈 배열 `[]`로 저장합니다.

## 변경 적용

1. 음성 자막을 중지합니다.
2. 설치 폴더에서 다음 명령으로 서버를 종료합니다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
   ```

3. Chrome 또는 Edge 확장 관리 화면에서 **Live English Captions**를 새로고침합니다.
4. YouTube 페이지도 새로고침한 뒤 자막을 시작합니다. 서버는 자동으로 다시 실행됩니다.

확장 설정의 커스텀 용어 카드에서 선택한 프로필 이름과 용어 수를 확인할 수 있습니다.

## 자동 적용 방식

현재 재생 영상의 소유자 링크가 등록한 채널 ID 또는 핸들과 일치할 때만 적용합니다.
영상 제목이나 추천 영상에 같은 문구가 등장하는 것만으로는 선택하지 않습니다.
YouTube에서 다른 채널로 이동하면 해당 프로필로 전환하거나 기본 인식으로 돌아갑니다.

Soniox 연결에서는 `context.terms`, Google Gemini 연결에서는
`inputAudioTranscription.customVocabulary`에 용어를 전달합니다.
연결 복구 시에도 같은 목록을 다시 적용합니다.
이는 받아쓰기용 어휘 힌트이며 출력 단어를 강제로 바꾸거나 정확도 향상을 보장하는 학습 모델은 아닙니다.
