"""Google Live Transcription adapter using the documented streaming protocol."""
import asyncio
import base64
import json
import time
from urllib.parse import quote

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from settings import GEMINI_MODEL, gemini_key
from channel_profiles import get_profile
from translation import EnglishCaptions
from api_limits import retry_delay

_retry_at = 0
_retry_key = ""


class ReconnectGeminiError(RuntimeError):
    """A fresh cloud session can recover without stopping browser capture."""
    def __init__(self, message, retry_after=None):
        super().__init__(message)
        self.retry_after = retry_after


def cloud_error(error):
    message = error.get("message", "Gemini streaming error.")
    if error.get("code") in (429, 500, 502, 503, 504) or error.get("status") in (
        "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"
    ):
        return ReconnectGeminiError(message, retry_delay(error, default=15 if error.get("code") == 429 else 2))
    return ValueError(message)


async def transcribe_gemini(socket, profile_id=None):
    global _retry_at, _retry_key
    key = gemini_key()
    if key != _retry_key:
        _retry_key, _retry_at = key, 0
    if time.monotonic() < _retry_at:
        raise ReconnectGeminiError("받아쓰기 API 대기시간을 지키고 있습니다…", _retry_at - time.monotonic())
    try:
        await run_session(socket, profile_id)
    except ReconnectGeminiError as error:
        if error.retry_after:
            _retry_at = time.monotonic() + error.retry_after
        raise
    except ConnectionClosed as error:
        if socket.close_code is not None:
            raise  # The browser stopped capture; do not reconnect it.
        code = error.rcvd.code if error.rcvd else 1006
        if code in (1002, 1007, 1008):
            raise ValueError("Gemini 연결이 거절됐습니다. API 키와 모델 접근 권한을 확인해 주세요.") from error
        raise ReconnectGeminiError("Gemini 연결이 끊겨 자동으로 다시 연결합니다…") from error
    except (TimeoutError, OSError) as error:
        raise ReconnectGeminiError("Gemini 응답이 지연되어 자동으로 다시 연결합니다…") from error
    except InvalidStatus as error:
        if error.response.status_code in (429, 500, 502, 503, 504):
            try:
                detail = json.loads(error.response.body).get("error", {})
            except (TypeError, ValueError, AttributeError):
                detail = {}
            delay = retry_delay(detail, error.response.headers, 15 if error.response.status_code == 429 else 2)
            _retry_at = time.monotonic() + delay
            raise ReconnectGeminiError("Gemini 서버에 잠시 후 다시 연결합니다…", delay) from error
        raise


def transcription_config(profile_id=None):
    config = {"languageCodes": [], "mode": "VERBATIM"}
    profile = get_profile(profile_id)
    if profile:
        config["customVocabulary"] = list(profile["vocabulary"])
    return config


async def run_session(socket, profile_id=None):
    key = gemini_key()
    if not key:
        raise ValueError("Gemini API 키가 없습니다. 확장 설정에서 키를 저장해 주세요.")
    endpoint = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" + quote(key, safe="")
    async with connect(endpoint, open_timeout=12, close_timeout=2, max_size=4 * 1024 * 1024, compression=None) as cloud:
        await cloud.send(json.dumps({"setup": {
            "model": "models/" + GEMINI_MODEL,
            "generationConfig": {"responseModalities": ["TEXT"]},
            "inputAudioTranscription": transcription_config(profile_id),
        }}))
        response = json.loads(await asyncio.wait_for(cloud.recv(), timeout=15))
        if "error" in response:
            raise cloud_error(response["error"])
        if "setupComplete" not in response:
            raise ValueError("Gemini did not acknowledge the transcription session.")
        await socket.send(json.dumps({"type": "ready", "engine": "gemini", "model": GEMINI_MODEL, "profile_id": profile_id}))
        finishing = asyncio.Event()
        audio_seconds = 0.0
        captions = EnglishCaptions(socket)

        async def upload():
            nonlocal audio_seconds
            async for message in socket:
                if isinstance(message, str):
                    if json.loads(message).get("type") == "stop":
                        finishing.set()
                        await cloud.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
                        return "drain"
                    continue
                if len(message) % 2 or len(message) > 32000:
                    raise ValueError("Invalid PCM16 packet.")
                audio_seconds += len(message) / 32000
                await cloud.send(json.dumps({"realtimeInput": {"audio": {
                    "data": base64.b64encode(message).decode("ascii"),
                    "mimeType": "audio/pcm;rate=16000",
                }}}))
            return "closed"

        async def receive():
            segment = 0
            async for payload in cloud:
                event = json.loads(payload)
                if "error" in event:
                    raise cloud_error(event["error"])
                if "goAway" in event:
                    raise ReconnectGeminiError("Gemini 세션을 갱신하고 있습니다…")
                content = event.get("serverContent", {})
                for field, final in (("interimInputTranscription", False), ("inputTranscription", True)):
                    transcript = content.get(field) or {}
                    text = transcript.get("text", "").strip()
                    if text:
                        captions.submit({
                            "type": "transcript", "text": text, "final": final,
                            "segment": segment, "engine": "gemini",
                            "audio_seconds": round(audio_seconds, 3),
                        }, transcript.get("languageCode", ""))
                        if final:
                            segment += 1
                if finishing.is_set() and content.get("turnComplete"):
                    return
            if not finishing.is_set():
                raise ReconnectGeminiError("Gemini 연결이 종료되어 자동으로 다시 연결합니다…")

        sender = asyncio.create_task(upload())
        receiver = asyncio.create_task(receive())
        translator = asyncio.create_task(captions.run())
        try:
            completed, _ = await asyncio.wait([sender, receiver, translator], return_when=asyncio.FIRST_COMPLETED)
            if translator in completed:
                await translator
            if sender in completed:
                result = await sender
                if result == "drain":
                    try:
                        await asyncio.wait_for(receiver, timeout=6)
                    except asyncio.TimeoutError:
                        pass
            else:
                await receiver
            if finishing.is_set():
                drained = asyncio.create_task(captions.idle.wait())
                try:
                    await asyncio.wait([drained, translator], timeout=12, return_when=asyncio.FIRST_COMPLETED)
                    if translator.done():
                        await translator
                finally:
                    drained.cancel()
                    await asyncio.gather(drained, return_exceptions=True)
        finally:
            for task in (sender, receiver, translator):
                if not task.done():
                    task.cancel()
            await asyncio.gather(sender, receiver, translator, return_exceptions=True)
        try:
            await socket.send(json.dumps({"type": "done"}))
        except ConnectionClosed:
            pass
