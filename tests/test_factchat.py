import asyncio
from collections import OrderedDict
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import factchat_engine
from factchat_engine import TranscriptBuffer, cloud_error, transcription_config
from gemini_engine import ReconnectGeminiError
import settings
import translation


def token(text, final=False, language="en"):
    return {"text": text, "is_final": final, "language": language}


class TranscriptTests(unittest.TestCase):
    def test_partial_tail_is_replaced_and_committed_words_are_not_duplicated(self):
        buffer = TranscriptBuffer()
        first = buffer.feed({"tokens": [token("Hello", True), token(" wor")]})
        second = buffer.feed({"tokens": [token(" world", True), token("!", True), token("<end>", True)]})
        self.assertEqual(first[0][0]["text"], "Hello wor")
        self.assertEqual(second[0][0]["text"], "Hello world!")
        self.assertTrue(second[0][0]["final"])
        next_event = buffer.feed({"tokens": [token("Next", True)], "finished": True})
        self.assertEqual(next_event[0][0]["segment"], 1)
        self.assertEqual(next_event[0][0]["text"], "Next")

    def test_short_english_is_identified_but_mixed_speech_is_not_passed_through(self):
        self.assertEqual(TranscriptBuffer().feed({"tokens": [token("Hi")]})[0][1], "en")
        events = TranscriptBuffer().feed({"tokens": [token("Hello ", True), token("amigos", True, "es")]})
        self.assertEqual(events[0][1], "mixed")

    def test_utterance_boundary_does_not_swallow_the_next_partial(self):
        events = TranscriptBuffer().feed({"tokens": [token("One", True), token("<end>", True), token("Two")]})
        self.assertEqual([(event["text"], event["final"], event["segment"]) for event, _ in events],
                         [("One", True, 0), ("Two", False, 1)])

    def test_continuous_speech_has_bounded_memory(self):
        buffer = TranscriptBuffer()
        finals = []
        for _ in range(1000):
            finals.extend(event for event, _ in buffer.feed({"tokens": [token("word ", True)]}) if event["final"])
        self.assertTrue(finals)
        self.assertLessEqual(len(buffer.final_tokens), 72)

    def test_channel_vocabulary_and_error_recovery(self):
        with patch("factchat_engine.get_profile", return_value={"vocabulary": ["Star Harbor", "Moon Crystal"]}):
            self.assertEqual(transcription_config("my-channel")["context"]["terms"], ["Star Harbor", "Moon Crystal"])
        self.assertNotIn("language_hints_strict", transcription_config())
        self.assertIsInstance(cloud_error({"error_code": 429}), ReconnectGeminiError)
        self.assertIsInstance(cloud_error({"error_code": 402}), ValueError)


class GatewayRequestTests(unittest.TestCase):
    def test_gateway_native_schema_image_auth_and_cache_remain_separate(self):
        calls = []
        def respond(request, **kwargs):
            calls.append(request)
            self.assertIsNotNone(kwargs.get("context"))
            return io.BytesIO(json.dumps({"candidates": [{"finishReason": "STOP", "content": {
                "parts": [{"text": '{"items": []}'}]}}]}).encode())
        with patch("translation.REQUEST_LANES", OrderedDict()), \
             patch("translation.service_key", return_value="baze_unit-test-key-never-real"), \
             patch("translation.service_provider", return_value="factchat"), \
             patch("translation.urllib.request.urlopen", respond):
            for _ in range(2):
                translation.generate("gemini-3.5-flash-lite", [{"inlineData": {"mimeType": "image/jpeg", "data": "/9j/"}}],
                                     "translate", translation.SCREEN_SCHEMA, "screen")
            with patch("translation.service_provider", return_value="google"):
                translation.generate("gemini-3.5-flash-lite", [{"inlineData": {"mimeType": "image/jpeg", "data": "/9j/"}}],
                                     "translate", translation.SCREEN_SCHEMA, "screen")
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].full_url.startswith(settings.FACTCHAT_BASE_URL + "/gemini/v1beta/models/"))
        self.assertEqual(calls[0].get_header("X-goog-api-key"), "baze_unit-test-key-never-real")
        payload = json.loads(calls[0].data)
        self.assertEqual(payload["generationConfig"]["responseSchema"], translation.SCREEN_SCHEMA)
        self.assertIn("inlineData", payload["contents"][0]["parts"][0])
        self.assertTrue(calls[1].full_url.startswith("https://generativelanguage.googleapis.com/"))

    def test_exhausted_credits_do_not_generate_repeated_requests(self):
        with patch("translation.REQUEST_LANES", OrderedDict()), \
             patch("translation.service_key", return_value="test-key"), \
             patch("translation.service_provider", return_value="factchat"), \
             patch("translation.urllib.request.urlopen", side_effect=HTTPError("test", 402, "Payment Required", {}, io.BytesIO())) as request:
            for _ in range(2):
                with self.assertRaises(ValueError):
                    translation.generate("gemini-3.5-flash-lite", [], "test", track="screen")
        self.assertEqual(request.call_count, 1)

    def test_shared_gateway_key_preserves_google_keys_and_is_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(json.dumps({"api_key": "original-google-audio-key", "screen_api_key": "original-google-screen-key",
                "transcription_provider": "factchat", "audio_provider": "factchat", "screen_provider": "factchat"}))
            with patch.object(settings, "SETTINGS_FILE", path), patch.dict("os.environ", {}, clear=True):
                settings.save_service_key("baze_replacement-test-key-12345", "screen")
                self.assertEqual(settings.service_key("transcription"), settings.service_key("screen"))
                self.assertEqual(settings.service_key("audio"), settings.service_key("screen"))
                self.assertEqual(settings.gemini_key(), "original-google-audio-key")
                self.assertEqual(settings.gemini_key("screen"), "original-google-screen-key")
                self.assertNotIn("baze_", settings.safe_error("baze_replacement-test-key-12345 baze_unknown-leaked-key"))


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_adapter_drains_english_without_translation_and_uses_text_end_frame(self):
        class Cloud:
            def __init__(self):
                self.sent, self.events = [], asyncio.Queue()
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def __aiter__(self): return self
            async def __anext__(self): return json.dumps(await self.events.get())
            async def send(self, value):
                self.sent.append(value)
                if value == "":
                    await self.events.put({"tokens": [token("Hi!", True)], "finished": True})
        class Browser:
            close_code = None
            def __init__(self): self.events = []
            async def send(self, value): self.events.append(json.loads(value))
            async def __aiter__(self):
                yield bytes(1280)
                yield json.dumps({"type": "stop"})
        cloud, browser = Cloud(), Browser()
        with patch("factchat_engine.connect", return_value=cloud) as connect, \
             patch("factchat_engine.get_profile", return_value={"vocabulary": ["Star Harbor", "Moon Crystal"]}), \
             patch("translation.translate_text", new_callable=AsyncMock) as translate:
            await asyncio.wait_for(factchat_engine.run_session(browser, "baze_fake-key", "my-channel"), 1)
        translate.assert_not_called()
        self.assertEqual([event["type"] for event in browser.events], ["ready", "transcript", "done"])
        self.assertEqual(browser.events[1]["text"], "Hi!")
        self.assertEqual(cloud.sent[-1], "")
        self.assertEqual(connect.call_args.kwargs["additional_headers"], {"Authorization": "Bearer baze_fake-key"})
        self.assertNotIn("baze_", connect.call_args.args[0])
        self.assertTrue(json.loads(cloud.sent[0])["context"]["terms"])


if __name__ == "__main__":
    unittest.main()
