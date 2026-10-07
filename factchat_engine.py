"""Soniox streaming transcription through the authenticated FactChat gateway."""
import asyncio
import json
import time

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from api_limits import retry_delay
from channel_profiles import get_profile
from gemini_engine import ReconnectGeminiError as ReconnectAudioError
from network import tls_context
from settings import FACTCHAT_BASE_URL, FACTCHAT_TRANSCRIBE_MODEL, factchat_key, safe_error
from translation import EnglishCaptions

_retry_at = 0
_retry_key = ""


def transcription_config(profile_id=None):
    config = {
        "model": FACTCHAT_TRANSCRIBE_MODEL, "audio_format": "pcm_s16le",
        "sample_rate": 16000, "num_channels": 1,
        "enable_language_identification": True, "enable_endpoint_detection": True,
    }
    profile = get_profile(profile_id)
    if profile:
        config["context"] = {"terms": list(profile["vocabulary"])}
    return config


def cloud_error(event):
    code = event.get("error_code")
    message = safe_error(event.get("error_message") or "FactChat transcription error.")
    if code in (408, 413, 429, 500, 502, 503, 504):
        return ReconnectAudioError(message, retry_delay(event, default=15 if code == 429 else 2))
    return ValueError(message)


class TranscriptBuffer:
    """Append committed tokens once and replace the speculative tail each update."""
    def __init__(self):
        self.final_tokens = []
        self.segment = 0
        self.previous = ""

    def emit(self, partial, final):
        tokens = self.final_tokens + partial
        text = "".join(token["text"] for token in tokens).strip()
        result = None
        if text and (final or text != self.previous):
            spoken = [token for token in tokens if any(char.isalpha() for char in token["text"])]
            languages = {token.get("language", "").lower().split("-")[0] for token in spoken}
            language = next(iter(languages)) if len(languages) == 1 else "mixed" if languages - {""} else ""
            result = ({"type": "transcript", "text": text, "final": final,
                       "segment": self.segment, "engine": "factchat", "model": FACTCHAT_TRANSCRIBE_MODEL}, language)
            self.previous = text
        if final:
            self.final_tokens = []
            self.previous = ""
            if text:
                self.segment += 1
        return result

    def feed(self, message):
        events, partial = [], []
        for token in message.get("tokens", []):
            text = token.get("text", "")
            if not text or token.get("translation_status") == "translation":
                continue
            if text in ("<end>", "<fin>"):
                if token.get("is_final"):
                    if event := self.emit(partial, True):
                        events.append(event)
                    partial = []
                continue
            if token.get("is_final"):
                self.final_tokens.append(token)
                # Bound long uninterrupted speech without retaining a session's transcript.
                if sum(len(item["text"]) for item in self.final_tokens) >= 360:
                    if event := self.emit([], True):
                        events.append(event)
            else:
                partial.append(token)
        if event := self.emit(partial, bool(message.get("finished"))):
            events.append(event)
        return events


async def transcribe_factchat(socket, profile_id=None):
    global _retry_at, _retry_key
    key = factchat_key()
    if not key:
        raise ValueError("FactChat API 키를 설정에서 저장해 주세요.")
    if key != _retry_key:
        _retry_key, _retry_at = key, 0
    if time.monotonic() < _retry_at:
        raise ReconnectAudioError("받아쓰기 API 대기시간을 지키고 있습니다…", _retry_at - time.monotonic())
    try:
        try:
            await run_session(socket, key, profile_id)
        except ConnectionClosed as error:
            if socket.close_code is not None:
                raise
            code = error.rcvd.code if error.rcvd else 1006
            if code in (1002, 1007, 1008, 4402):
                reason = safe_error(error.rcvd.reason if error.rcvd else error)
                raise ValueError("FactChat 받아쓰기 연결 거절: " + reason) from error
            raise ReconnectAudioError("FactChat 받아쓰기에 다시 연결합니다…", 15 if code == 1013 else 2) from error
        except InvalidStatus as error:
            if error.response.status_code in (429, 500, 502, 503, 504):
                raise ReconnectAudioError("FactChat 연결을 잠시 후 재시도합니다…",
                    retry_delay(headers=error.response.headers, default=15)) from error
            raise ValueError(f"FactChat 받아쓰기 연결 거절 (HTTP {error.response.status_code}). API 키와 크레딧을 확인해 주세요.") from error
        except (TimeoutError, OSError) as error:
            raise ReconnectAudioError("FactChat 받아쓰기 연결이 지연되어 재시도합니다…", 2) from error
    except ReconnectAudioError as error:
        if error.retry_after:
            _retry_at = time.monotonic() + error.retry_after
        raise


async def run_session(socket, key, profile_id=None):
    endpoint = FACTCHAT_BASE_URL.replace("https://", "wss://", 1) + "/soniox/transcribe-websocket"
    async with connect(endpoint, additional_headers={"Authorization": "Bearer " + key},
                       ssl=tls_context(), open_timeout=12, close_timeout=2,
                       max_size=4 * 1024 * 1024, compression=None) as cloud:
        await cloud.send(json.dumps(transcription_config(profile_id)))
        await socket.send(json.dumps({"type": "ready", "engine": "factchat",
            "model": FACTCHAT_TRANSCRIBE_MODEL, "profile_id": profile_id}))
        finishing = asyncio.Event()
        captions = EnglishCaptions(socket)
        audio_seconds = 0.0

        async def upload():
            nonlocal audio_seconds
            async for message in socket:
                if isinstance(message, str):
                    if json.loads(message).get("type") == "stop":
                        finishing.set()
                        await cloud.send("")  # Soniox requires an empty TEXT frame to finish.
                        return "drain"
                    continue
                if not message or len(message) % 2 or len(message) > 32000:
                    raise ValueError("Invalid PCM16 packet.")
                audio_seconds += len(message) / 32000
                await cloud.send(message)
            return "closed"

        async def receive():
            buffer = TranscriptBuffer()
            async for payload in cloud:
                message = json.loads(payload)
                if message.get("error_code") is not None:
                    raise cloud_error(message)
                for event, language in buffer.feed(message):
                    captions.submit({**event, "audio_seconds": round(audio_seconds, 3)}, language)
                if message.get("finished"):
                    if not finishing.is_set():
                        raise ReconnectAudioError("FactChat 받아쓰기 세션을 갱신합니다…", 2)
                    return
            if not finishing.is_set():
                raise ReconnectAudioError("FactChat 받아쓰기 연결이 종료되어 다시 연결합니다…", 2)

        sender = asyncio.create_task(upload())
        receiver = asyncio.create_task(receive())
        translator = asyncio.create_task(captions.run())
        try:
            completed, _ = await asyncio.wait([sender, receiver, translator], return_when=asyncio.FIRST_COMPLETED)
            if translator in completed:
                await translator
            if sender in completed:
                if await sender == "drain":
                    await asyncio.wait_for(receiver, timeout=10)
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
                task.cancel()
            await asyncio.gather(sender, receiver, translator, return_exceptions=True)
        try:
            await socket.send(json.dumps({"type": "done"}))
        except ConnectionClosed:
            pass
