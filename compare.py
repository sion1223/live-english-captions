"""Replay the same English PCM in real time, then report latency and word error rate."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time
import urllib.request
import wave

from websockets.asyncio.client import connect

from download_model import BASE_URL
from settings import safe_error

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".run" / "samples"


def fetch_sample(name):
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / name
    if not target.exists():
        with urllib.request.urlopen(BASE_URL + "test_wavs/" + name, timeout=45) as response:
            target.write_bytes(response.read())
    return target


def words(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower())


def word_errors(reference, actual):
    expected, received = words(reference), words(actual)
    previous = list(range(len(received) + 1))
    for i, word in enumerate(expected, 1):
        current = [i]
        for j, other in enumerate(received, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (word != other)))
        previous = current
    return previous[-1], len(expected)


async def measure(engine, path, reference):
    result = {"engine": engine, "sample": path.name, "reference": reference}
    events = []
    try:
        with wave.open(str(path), "rb") as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
                raise ValueError("Comparison requires 16 kHz mono PCM16 WAV.")
            pcm = wav.readframes(wav.getnframes())
        duration = len(pcm) / 32000
        start_connect = time.perf_counter()
        async with connect("ws://127.0.0.1:8765/asr", compression=None, open_timeout=5, close_timeout=2) as socket:
            await socket.send(json.dumps({"engine": engine, "sample_rate": 16000, "format": "pcm_s16le"}))
            ready = json.loads(await asyncio.wait_for(socket.recv(), timeout=32))
            if ready.get("type") != "ready":
                raise ValueError(ready.get("message", "Engine not ready."))
            result["connection_ms"] = round((time.perf_counter() - start_connect) * 1000, 1)
            start = time.perf_counter()

            async def receive():
                async for payload in socket:
                    event = json.loads(payload)
                    if event.get("type") == "error":
                        raise ValueError(event.get("message", "Recognition failed."))
                    if event.get("type") == "transcript":
                        event["received_ms"] = round((time.perf_counter() - start) * 1000, 1)
                        events.append(event)
                    if event.get("type") == "done":
                        return

            receiver = asyncio.create_task(receive())
            try:
                # Each packet becomes available only after its 40 ms of audio elapsed.
                # This avoids giving a batch engine future audio during the comparison.
                for offset in range(0, len(pcm), 1280):
                    chunk = pcm[offset:offset + 1280]
                    deadline = start + (offset + len(chunk)) / 32000
                    await asyncio.sleep(max(0, deadline - time.perf_counter()))
                    if receiver.done():
                        await receiver
                        raise ValueError("Engine ended before all sample audio was sent.")
                    await socket.send(chunk)
                audio_end_ms = (time.perf_counter() - start) * 1000
                await socket.send(json.dumps({"type": "stop"}))
                await asyncio.wait_for(receiver, timeout=12)
            finally:
                if not receiver.done():
                    receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)

        if not events:
            raise ValueError("No transcript received.")
        segments = {}
        revisions = 0
        for event in events:
            segment = event.get("segment", 0)
            older = segments.get(segment)
            if older and not older["final"]:
                old_words, new_words = words(older["text"]), words(event["text"])
                if new_words[:len(old_words)] != old_words:
                    revisions += 1
            segments[segment] = event
        transcript = " ".join(segments[key]["text"] for key in sorted(segments))
        errors, count = word_errors(reference, transcript)
        result.update({
            "status": "ok", "duration_s": round(duration, 3),
            "first_text_ms": events[0]["received_ms"],
            "last_result_after_audio_end_ms": round(events[-1]["received_ms"] - audio_end_ms, 1),
            "updates": len(events), "revised_updates": revisions,
            "all_segments_final": all(event["final"] for event in segments.values()),
            "word_errors": errors, "reference_words": count,
            "wer_percent": round(errors / count * 100, 1) if count else None,
            "transcript": transcript, "events": events,
        })
    except Exception as error:
        result.update({"status": "error", "error": safe_error(error), "events": events})
    return result


def write_report(rows):
    destination = ROOT / "reports"
    destination.mkdir(exist_ok=True)
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "rows": rows}
    (destination / "comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# 영어 자막 MVP 비교", "", f"측정 시각: {report['created_at']}", "",
        "동일한 WAV를 40ms PCM 패킷으로 실제 재생 속도에 맞춰 전송했습니다. 두 엔진의 연결 시간은 별도 측정합니다.", "",
        "| 엔진 | 샘플 | 연결 | 첫 텍스트 | 마지막 결과 − 음성 끝 | 단어 오류율 | 중간 결과 수정 |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        if row["status"] != "ok":
            reason = row.get("error", "API 키 입력 대기").replace("|", "/").replace("\n", " ")
            lines.append(f"| {row['engine']} | {row['sample']} | — | {reason} | — | — | — |")
        else:
            lines.append(f"| {row['engine']} | {row['sample']} | {row['connection_ms']:.0f} ms | {row['first_text_ms']:.0f} ms | {row['last_result_after_audio_end_ms']:.0f} ms | {row['wer_percent']}% | {row['revised_updates']} |")
    lines += ["", "## 측정 범위", "",
        "- 첫 텍스트: 샘플 재생 시작부터 첫 인식 결과까지. 첫 단어가 끝난 시점 기준 지연이나 단어별 지연은 아닙니다.",
        "- 마지막 결과 − 음성 끝: 마지막 텍스트 이벤트 시각에서 실제 오디오 전송 완료 시각을 뺀 값. 음수면 파일의 후행 무음이 끝나기 전에 결과가 나왔다는 뜻입니다.",
        "- 단어 오류율(WER): 대소문자와 문장부호를 제외하고 기준 문장과 비교한 삽입·삭제·치환 비율. 낮을수록 좋습니다.",
        "- 샘플 2개의 빠른 비교이며 유튜브의 배경음·사투리·겹치는 발화를 대표하지 않습니다.",
        "- Chrome 오디오 캡처와 화면 렌더링 지연은 포함하지 않습니다. 실제 영상 위 자막은 별도 확인이 필요합니다.",
        "- Gemini 키 또는 모델 접근 권한이 없으면 측정하지 않으며, 추정 수치를 넣지 않습니다.", "",
        "## 인식 결과", ""]
    for row in rows:
        if row["status"] == "ok":
            lines += [f"### {row['engine']} / {row['sample']}", "", row["transcript"], "",
                      f"모든 구간 확정: {row['all_segments_final']}", ""]
    (destination / "comparison.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"Report: {destination / 'comparison.md'}", flush=True)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["local", "gemini", "both"], default="both")
    args = parser.parse_args()
    with urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=3) as response:
        health = json.load(response)
    references = {}
    for line in fetch_sample("trans.txt").read_text(encoding="utf-8").splitlines():
        name, reference = line.split(" ", 1)
        references[name] = reference
    requested = ["local", "gemini"] if args.engine == "both" else [args.engine]
    rows = []
    for name in ("0.wav", "1.wav"):
        path = fetch_sample(name)
        available = [engine for engine in requested if engine == "local" or health.get("gemini_configured")]
        for engine in requested:
            if engine not in available:
                rows.append({"engine": engine, "sample": name, "status": "skipped", "error": "Gemini API key not configured"})
        print(f"Streaming {name}: {', '.join(available) or 'no configured engine'}", flush=True)
        completed = await asyncio.gather(*(measure(engine, path, references[name]) for engine in available))
        rows.extend(completed)
        for row in completed:
            summary = {key: value for key, value in row.items() if key not in ("events", "reference", "transcript")}
            print(json.dumps(summary, ensure_ascii=True), flush=True)
    write_report(rows)


if __name__ == "__main__":
    asyncio.run(main())
