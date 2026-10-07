# 영어 자막 MVP 비교

측정 시각: 2026-09-25T14:33:29.359691+00:00

동일한 WAV를 40ms PCM 패킷으로 실제 재생 속도에 맞춰 전송했습니다. 두 엔진의 연결 시간은 별도 측정합니다.

| 엔진 | 샘플 | 연결 | 첫 텍스트 | 마지막 결과 − 음성 끝 | 단어 오류율 | 중간 결과 수정 |
|---|---|---:|---:|---:|---:|---:|
| gemini | 0.wav | — | Gemini API key not configured | — | — | — |
| local | 0.wav | 5 ms | 2388 ms | 84 ms | 22.2% | 5 |
| gemini | 1.wav | — | Gemini API key not configured | — | — | — |
| local | 1.wav | 6 ms | 1422 ms | 71 ms | 4.2% | 11 |

## 측정 범위

- 첫 텍스트: 샘플 재생 시작부터 첫 인식 결과까지. 첫 단어가 끝난 시점 기준 지연이나 단어별 지연은 아닙니다.
- 마지막 결과 − 음성 끝: 마지막 텍스트 이벤트 시각에서 실제 오디오 전송 완료 시각을 뺀 값. 음수면 파일의 후행 무음이 끝나기 전에 결과가 나왔다는 뜻입니다.
- 단어 오류율(WER): 대소문자와 문장부호를 제외하고 기준 문장과 비교한 삽입·삭제·치환 비율. 낮을수록 좋습니다.
- 샘플 2개의 빠른 비교이며 유튜브의 배경음·사투리·겹치는 발화를 대표하지 않습니다.
- Chrome 오디오 캡처와 화면 렌더링 지연은 포함하지 않습니다. 실제 영상 위 자막은 별도 확인이 필요합니다.
- Gemini 키 또는 모델 접근 권한이 없으면 측정하지 않으며, 추정 수치를 넣지 않습니다.

## 인식 결과

### local / 0.wav

THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE THE SQUALID QUARTER OF THE BRAFFLELS

모든 구간 확정: True

### local / 1.wav

AS A DIRECT CONSEQUENCE OF THE SIN WHICH MAN THUS PUNISHED HAD GIVEN HER A LOVELY CHILD WHOSE PLACE WAS ON THAT SAME DISHONORED BOSOM TO CONNECT HER PARENT FOR EVER WITH THE RACE AND DESCENT OF MORTALS AND TO BE FINALLY A BLESSED SOUL IN HEAVEN

모든 구간 확정: True
