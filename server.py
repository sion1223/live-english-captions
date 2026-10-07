"""Local relay for streaming English captions and video-text translation."""
import asyncio
from http import HTTPStatus
import json
import os
import re
import time

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from download_model import MODEL_DIR, FILES
from gemini_engine import transcribe_gemini, ReconnectGeminiError
from factchat_engine import transcribe_factchat
from settings import (GEMINI_MODEL, CAPTION_TRANSLATION_MODEL, SCREEN_TRANSLATION_MODEL,
                      FACTCHAT_TRANSCRIBE_MODEL, service_key, service_provider, save_service_key, safe_error)
from translation import translate_screen, usage_snapshot

PORT = 8765


def make_recognizer():
    import sherpa_onnx
    for name in FILES:
        if not (MODEL_DIR / name).is_file():
            raise SystemExit("Model missing. Run setup.ps1 first.")
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(MODEL_DIR / "tokens.txt"),
        encoder=str(MODEL_DIR / FILES[0]),
        decoder=str(MODEL_DIR / FILES[1]),
        joiner=str(MODEL_DIR / FILES[2]),
        num_threads=min(4, os.cpu_count() or 2),
        sample_rate=16000,
        decoding_method="greedy_search",
        provider="cpu",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4,
        rule2_min_trailing_silence=0.65,
        rule3_min_utterance_length=15,
    )


def health(connection, request):
    if request.path == "/health":
        providers = {track: service_provider(track) for track in ("transcription", "audio", "screen")}
        gateway_audio = providers["transcription"] == "factchat"
        response = connection.respond(HTTPStatus.OK, json.dumps({
            "app": "live-english-captions", "ready": True, "version": "0.6.0",
            "protocol_version": 5, "translation_model": CAPTION_TRANSLATION_MODEL,
            "caption_translation_model": CAPTION_TRANSLATION_MODEL, "screen_translation_model": SCREEN_TRANSLATION_MODEL,
            "gemini_configured": bool(service_key("transcription")), "gemini_model": GEMINI_MODEL,
            "transcription_configured": bool(service_key("transcription")),
            "transcription_engine": "factchat" if gateway_audio else "gemini",
            "transcription_model": FACTCHAT_TRANSCRIBE_MODEL if gateway_audio else GEMINI_MODEL,
            "providers": providers,
            "screen_configured": bool(service_key("screen")),
            "separate_keys": bool(service_key("screen")) and service_key("screen") != service_key("audio"),
            "usage": usage_snapshot(),
        }))
        response.headers["Content-Type"] = "application/json"
        response.headers["Cache-Control"] = "no-store"
        return response
    if request.path not in ("/asr", "/settings", "/screen"):
        return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")


async def main():
    recognizer = None
    busy = set()

    async def handle(socket):
        engine = None
        acquired = False
        try:
            first = await asyncio.wait_for(socket.recv(), timeout=8)
            if not isinstance(first, str):
                raise ValueError("Send an audio configuration before PCM data.")
            config = json.loads(first)
            if not isinstance(config, dict):
                raise ValueError("Expected a configuration object.")
            if socket.request.path == "/settings":
                save_service_key(config.get("api_key", ""), config.get("track", "audio"))
                await socket.send(json.dumps({"type": "saved"}))
                return
            if socket.request.path == "/screen":
                if "screen" in busy:
                    raise ValueError("A screen translation is already in progress.")
                engine = "screen"
                busy.add(engine)
                acquired = True
                result = await translate_screen(config.get("image", ""))
                await socket.send(json.dumps({"type": "screen", "track": "screen", **result}))
                return
            engine = config.get("engine", "local")
            if engine not in ("local", "gemini", "factchat"):
                raise ValueError("Unknown recognition engine.")
            if engine != "local":
                # Resolve the selected cloud provider on reconnect, including older extensions.
                engine = "factchat" if service_provider("transcription") == "factchat" else "gemini"
            if config.get("sample_rate") != 16000 or config.get("format") != "pcm_s16le":
                raise ValueError("Expected 16 kHz mono PCM16 audio.")
            if engine in busy:
                raise ReconnectGeminiError("이전 음성 연결을 정리하고 있습니다. 잠시 후 다시 연결합니다…")
            busy.add(engine)
            acquired = True
            if engine == "factchat":
                await transcribe_factchat(socket, config.get("profile_id"))
            elif engine == "gemini":
                await transcribe_gemini(socket, config.get("profile_id"))
            else:
                await transcribe_local(socket)
        except ConnectionClosed:
            pass
        except Exception as error:
            message = safe_error(error)
            track = socket.request.path.lstrip("/")
            print(f"{track} error: {message}", flush=True)
            try:
                await socket.send(json.dumps({
                    "type": "error", "track": track, "message": message,
                    "recoverable": isinstance(error, ReconnectGeminiError),
                    "retry_after": getattr(error, "retry_after", None),
                }))
            except ConnectionClosed:
                pass
        finally:
            if acquired:
                busy.discard(engine)

    async def transcribe_local(socket):
        import numpy as np
        nonlocal recognizer
        if recognizer is None:
            recognizer = await asyncio.to_thread(make_recognizer)
        stream = recognizer.create_stream()
        previous = ""
        segment = 0
        audio_seconds = 0.0

        def decode(samples, finish=False):
            started = time.perf_counter()
            stream.accept_waveform(16000, samples)
            if finish:
                stream.input_finished()
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            text = recognizer.get_result(stream).strip()
            final = finish or recognizer.is_endpoint(stream)
            if final and not finish:
                recognizer.reset(stream)
            return text, final, round((time.perf_counter() - started) * 1000, 1)

        async def send_result(samples, finish=False):
            nonlocal previous, segment
            text, final, decode_ms = await asyncio.to_thread(decode, samples, finish)
            if (text and text != previous) or (final and (text or previous)):
                await socket.send(json.dumps({
                    "type": "transcript", "text": text or previous,
                    "final": final, "segment": segment,
                    "audio_seconds": round(audio_seconds, 3), "decode_ms": decode_ms, "engine": "local",
                }))
            if final:
                segment += 1
                previous = ""
            else:
                previous = text

        try:
            await socket.send(json.dumps({"type": "ready", "engine": "local"}))
            async for message in socket:
                if isinstance(message, str):
                    if json.loads(message).get("type") == "stop":
                        await send_result(np.zeros(8000, dtype=np.float32), finish=True)
                        await socket.send(json.dumps({"type": "done"}))
                        break
                    continue
                if len(message) % 2 or len(message) > 32000:
                    raise ValueError("Invalid audio packet.")
                samples = np.frombuffer(message, dtype="<i2").astype(np.float32) / 32768.0
                audio_seconds += len(samples) / 16000
                await send_result(samples)
        except ConnectionClosed:
            pass

    async with serve(
        handle, "127.0.0.1", PORT,
        origins=[re.compile(r"chrome-extension://[a-p]{32}"), None],
        process_request=health, compression=None,
        max_size=2 * 1024 * 1024, max_queue=8, close_timeout=2,
    ):
        print(f"READY http://127.0.0.1:{PORT}/health", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
