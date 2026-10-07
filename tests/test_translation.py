import asyncio
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import struct
import sys
import threading
import time
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_host import read_message
from translation import EnglishCaptions, TranslationBusyError, clearly_english, translate_screen, translate_text, validate_items, generate, usage_snapshot
from gemini_engine import transcription_config, cloud_error
from settings import CAPTION_TRANSLATION_MODEL, SCREEN_TRANSLATION_MODEL
import settings
from api_limits import retry_delay


class ValidationTests(unittest.TestCase):
    def test_automatic_language_and_vocabulary(self):
        with patch("gemini_engine.get_profile", return_value={"vocabulary": ["Star Harbor", "Moon Crystal"]}):
            config = transcription_config("my-channel")
        self.assertEqual(config["languageCodes"], [])
        self.assertEqual(config["customVocabulary"], ["Star Harbor", "Moon Crystal"])

    def test_invalid_boxes_are_never_sent_to_the_overlay(self):
        valid = {"source": "bonjour", "english": "hello", "box": [100, 100, 200, 200]}
        result = validate_items({"items": [valid,
            {**valid, "box": [200, 100, 100, 200]},
            {**valid, "box": [0, 0, float("nan"), 100]},
            {**valid, "box": [0, 0, 1001, 100]},
            {**valid, "english": 7}, {**valid, "box": [True, 0, 100, 100]},
        ]})
        self.assertEqual(result, [valid])

    def test_english_fast_path_does_not_assume_ascii_means_english(self):
        for text in ["This is an English sentence about a new game.",
                     "Okay, so I think we should go over there.",
                     "Wizards are my favorite type of pirates."]:
            self.assertTrue(clearly_english(text), text)
        for text in ["Bonjour tout le monde, nous allons commencer.",
                     "Hola amigos, vamos a jugar a un juego nuevo.",
                     "Hello everyone, gracias por venir al directo.",
                     "Hello everyone, \uc774\uc81c \uac8c\uc784\uc744 \uc2dc\uc791\ud569\ub2c8\ub2e4."]:
            self.assertFalse(clearly_english(text))

    def test_launcher_rejects_unbounded_or_incomplete_messages(self):
        with self.assertRaises(ValueError):
            read_message(io.BytesIO(struct.pack("<I", 100000)))
        with self.assertRaises(ValueError):
            read_message(io.BytesIO(struct.pack("<I", 40) + b"{}"))
        body = b'{"action":"ensure_server"}'
        self.assertEqual(read_message(io.BytesIO(struct.pack("<I", len(body)) + body)),
                         {"action": "ensure_server"})


class CaptionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.events = []
        class Socket:
            async def send(_, event):
                self.events.append(json.loads(event))
        self.captions = EnglishCaptions(Socket())
        self.task = asyncio.create_task(self.captions.run())

    async def asyncTearDown(self):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)

    def event(self, text, segment=0, final=True):
        return {"type": "transcript", "segment": segment, "text": text, "final": final}

    async def test_english_passthrough_and_final_drain(self):
        self.captions.submit(self.event("Hello there."), "en-US")
        await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual(self.events[0]["text"], "Hello there.")

    async def test_latest_partial_replaces_stale_pending_text(self):
        translated = []
        async def translate(text):
            translated.append(text)
            return "English " + text
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("old", final=False))
            self.captions.submit(self.event("final"))
            await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual(translated, ["final"])
        self.assertTrue(self.events[0]["final"])

    async def test_slow_translation_is_not_marked_drained_early(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def translate(text):
            entered.set()
            await finish.wait()
            return "English"
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("foreign"))
            await asyncio.wait_for(entered.wait(), 1)
            self.assertFalse(self.captions.idle.is_set())
            finish.set()
            await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual(self.events[0]["text"], "English")

    async def test_backlog_is_bounded_and_recent_segments_win(self):
        for segment in range(20):
            self.captions.submit(self.event(str(segment), segment), "en")
        self.assertEqual(len(self.captions.pending), 3)
        await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual([event["segment"] for event in self.events], [17, 18, 19])

    async def test_rate_limit_keeps_worker_alive_and_recovers(self):
        called = 0
        async def translate(text):
            nonlocal called
            called += 1
            if called == 1:
                error = TranslationBusyError()
                error.retry_after = 0.01
                self.captions.next_request = 0
                raise error
            return "Recovered"
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("foreign"))
            await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertFalse(self.task.done())
        self.assertEqual(self.events[0]["type"], "translation_status")
        self.assertEqual(self.events[-1]["text"], "Recovered")

    async def test_english_partial_bypasses_slow_foreign_request(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def translate(text):
            entered.set()
            await finish.wait()
            return "Old translation"
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("foreign"), "fr")
            await asyncio.wait_for(entered.wait(), 1)
            self.captions.submit(self.event("English is already arriving.", 1, False), "en")
            async def delivered():
                while not self.events:
                    await asyncio.sleep(0.005)
            await asyncio.wait_for(delivered(), 0.25)
            self.assertFalse(finish.is_set())
            self.assertEqual(self.events[0]["text"], "English is already arriving.")
            self.assertLess(self.events[0]["translation_ms"], 200)
            finish.set()
            await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual(len(self.events), 1, "old translation must not overwrite a newer caption")

    async def test_new_english_revision_bypasses_same_segment_translation(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def translate(text):
            entered.set()
            await finish.wait()
            return "Outdated partial"
        with patch("translation.translate_text", translate), patch("translation.clearly_english", lambda text: len(text) > 16):
            self.captions.submit(self.event("short", final=False))
            await asyncio.wait_for(entered.wait(), 1)
            self.captions.submit(self.event("Now this is clearly an English sentence."))
            async def delivered():
                while not self.events:
                    await asyncio.sleep(0.005)
            await asyncio.wait_for(delivered(), 0.25)
            finish.set()
            await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual(len(self.events), 1)
        self.assertTrue(self.events[0]["final"])

    async def test_rate_limit_does_not_hold_english_captions(self):
        entered = asyncio.Event()
        async def translate(text):
            entered.set()
            raise TranslationBusyError(30)
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("foreign"), "fr")
            await asyncio.wait_for(entered.wait(), 1)
            self.captions.submit(self.event("Hello from the live stream.", 1), "en")
            await asyncio.wait_for(self.captions.idle.wait(), 0.25)
        self.assertEqual(self.events[-1]["text"], "Hello from the live stream.")
        self.assertFalse(self.task.done())

    async def test_foreign_captions_have_no_fixed_multi_second_delay(self):
        async def translate(text):
            return "English " + text
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("premier"), "fr")
            await asyncio.wait_for(self.captions.idle.wait(), 1)
            self.captions.submit(self.event("deuxieme", 1), "fr")
            await asyncio.wait_for(self.captions.idle.wait(), 0.25)
        self.assertEqual(len(self.events), 2)

    async def test_foreign_queue_coalesces_while_another_request_runs(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        translated = []
        async def translate(text):
            translated.append(text)
            if len(translated) == 1:
                entered.set()
                await finish.wait()
            return "English " + text
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("first"), "fr")
            await asyncio.wait_for(entered.wait(), 1)
            for revision in range(20):
                self.captions.submit(self.event(str(revision), 1, False), "fr")
            self.captions.submit(self.event("latest", 1), "fr")
            finish.set()
            await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual(translated, ["first", "latest"])

    async def test_cancellation_stops_both_caption_workers(self):
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def translate(text):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("foreign"), "fr")
            await asyncio.wait_for(entered.wait(), 1)
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.assertTrue(cancelled.is_set())
            self.captions.submit(self.event("Must not appear after stop.", 1), "en")
            await asyncio.sleep(0.02)
        self.assertEqual(self.events, [])

    async def test_translation_timeout_or_bad_response_never_kills_audio_worker(self):
        for segment, failure in enumerate((TimeoutError("translation timeout"), ValueError("invalid translation"))):
            async def translate(text):
                raise failure
            with patch("translation.translate_text", translate):
                self.captions.submit(self.event("foreign", segment * 2), "fr")
                await asyncio.wait_for(self.captions.idle.wait(), 1)
                self.captions.submit(self.event("Still listening.", segment * 2 + 1), "en")
                await asyncio.wait_for(self.captions.idle.wait(), 0.25)
                self.assertEqual(self.events[-1]["text"], "Still listening.")
                self.assertFalse(self.task.done())

    async def test_final_arriving_during_identical_partial_reuses_one_call(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        requests = []
        async def translate(text):
            requests.append(text)
            entered.set()
            await finish.wait()
            return "Hello"
        with patch("translation.translate_text", translate):
            self.captions.submit(self.event("bonjour", final=False), "fr")
            await asyncio.wait_for(entered.wait(), 1)
            self.captions.submit(self.event("bonjour"), "fr")
            await asyncio.sleep(0.01)
            finish.set()
            await asyncio.wait_for(self.captions.idle.wait(), 1)
        self.assertEqual(requests, ["bonjour"])
        self.assertTrue(self.events[-1]["final"])

    async def test_streaming_partials_coalesce_but_final_does_not_wait(self):
        requests = []
        async def translate(text):
            requests.append(text)
            return "Translated " + text
        with patch("translation.translate_text", translate):
            for revision in range(16):
                self.captions.submit(self.event("revision " + str(revision), final=False), "fr")
                await asyncio.sleep(0.05)
            self.captions.submit(self.event("complete sentence"), "fr")
            await asyncio.wait_for(self.captions.idle.wait(), 0.25)
        self.assertLessEqual(len(requests), 3)
        self.assertEqual(requests[-1], "complete sentence")


class RequestIsolationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        provider = patch("translation.service_provider", return_value="google")
        provider.start()
        self.addCleanup(provider.stop)
        self.lanes = patch("translation.REQUEST_LANES", OrderedDict())
        self.lanes.start()
        self.addCleanup(self.lanes.stop)
    async def test_screen_429_does_not_rate_limit_short_or_foreign_captions(self):
        requests, events = [], []
        class Socket:
            async def send(_, event):
                events.append(json.loads(event))
        def urlopen(request, timeout, **kwargs):
            body = json.loads(request.data)
            requests.append((request.full_url, body["contents"][0]["parts"]))
            if f"/{SCREEN_TRANSLATION_MODEL}:" in request.full_url:
                raise HTTPError(request.full_url, 429, "Too Many Requests", {"Retry-After": "30"}, io.BytesIO())
            return io.BytesIO(json.dumps({"candidates": [{"finishReason": "STOP",
                "content": {"parts": [{"text": "Hello"}]}}]}).encode())
        captions = EnglishCaptions(Socket())
        worker = asyncio.create_task(captions.run())
        try:
            with patch("translation.urllib.request.urlopen", urlopen), patch("translation.service_key", return_value="test-key"):
                with self.assertRaises(TranslationBusyError) as error:
                    await translate_screen("data:image/jpeg;base64,/9j/")
                self.assertEqual(error.exception.retry_after, 30)
                self.assertEqual(captions.next_request, 0)
                # Neither path can rely on the English detector to bypass the real request.
                for segment, (text, language) in enumerate([("Hi", ""), ("Bonjour", "fr")]):
                    captions.submit({"type": "transcript", "segment": segment, "text": text, "final": True}, language)
                    await asyncio.wait_for(captions.idle.wait(), 0.5)
                self.assertEqual([event["type"] for event in events], ["transcript", "transcript"])
                self.assertEqual(captions.next_request, 0)
        finally:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
        self.assertNotEqual(CAPTION_TRANSLATION_MODEL, SCREEN_TRANSLATION_MODEL)
        self.assertEqual(len(requests), 3)
        self.assertIn(f"/{SCREEN_TRANSLATION_MODEL}:", requests[0][0])
        self.assertIn("inlineData", requests[0][1][1])
        for url, parts in requests[1:]:
            self.assertIn(f"/{CAPTION_TRANSLATION_MODEL}:", url)
            self.assertEqual(len(parts), 1)
            self.assertNotIn("inlineData", parts[0])

    async def test_blocked_screen_request_cannot_occupy_caption_workers(self):
        # A single default worker reproduces starvation if either lane uses to_thread.
        asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=1))
        entered, finish = threading.Event(), threading.Event()
        threads = []
        def generate(model, parts, instruction, schema=None, track="audio"):
            threads.append(threading.current_thread().name)
            if schema:
                entered.set()
                finish.wait(3)
                return '{"items": []}'
            return "Hello"
        with patch("translation.generate", generate):
            screen = asyncio.create_task(translate_screen("data:image/jpeg;base64,/9j/"))
            try:
                async def started():
                    while not entered.is_set():
                        await asyncio.sleep(0.005)
                await asyncio.wait_for(started(), 1)
                started_at = time.monotonic()
                self.assertEqual(await asyncio.wait_for(translate_text("bonjour"), 0.25), "Hello")
                self.assertLess(time.monotonic() - started_at, 0.25)
                self.assertFalse(screen.done())
            finally:
                finish.set()
                await asyncio.gather(screen, return_exceptions=True)
        self.assertTrue(threads[0].startswith("screen-translation"))
        self.assertTrue(threads[1].startswith("caption-translation"))


class CredentialTests(unittest.TestCase):
    def test_keys_are_saved_independently_and_legacy_audio_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with patch.object(settings, "SETTINGS_FILE", path / "settings.json"), \
                 patch.object(settings, "LEGACY_SETTINGS_FILE", path / "legacy.json"), patch.dict("os.environ", {}, clear=True):
                (path / "legacy.json").write_text(json.dumps({"api_key": "original-audio-key-12345"}))
                self.assertEqual(settings.gemini_key("screen"), "", "screen must not fall back to audio")
                settings.save_gemini_key("separate-screen-key-12345", "screen")
                self.assertEqual(settings.gemini_key(), "original-audio-key-12345")
                self.assertEqual(settings.gemini_key("screen"), "separate-screen-key-12345")
                settings.save_gemini_key("replacement-audio-key-12345")
                self.assertEqual(settings.gemini_key("screen"), "separate-screen-key-12345")
                self.assertNotIn("separate-screen", settings.safe_error("separate-screen-key-12345"))
                with self.assertRaises(ValueError):
                    settings.save_gemini_key("do-not-write-this-key-12345", "invalid")


class RequestBudgetTests(unittest.TestCase):
    def setUp(self):
        provider = patch("translation.service_provider", return_value="google")
        provider.start()
        self.addCleanup(provider.stop)
        self.lanes = patch("translation.REQUEST_LANES", OrderedDict())
        self.lanes.start()
        self.addCleanup(self.lanes.stop)
        self.keys = patch("translation.service_key", side_effect=lambda track="audio": "key-" + track)
        self.keys.start()
        self.addCleanup(self.keys.stop)

    @staticmethod
    def response(text="Hello"):
        return io.BytesIO(json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}],
                                     "usageMetadata": {"promptTokenCount": 40, "candidatesTokenCount": 2}}).encode())

    def test_two_tracks_use_distinct_keys_even_when_model_is_identical(self):
        keys = []
        def urlopen(request, timeout, **kwargs):
            keys.append(request.get_header("X-goog-api-key"))
            if keys[-1] == "key-screen":
                raise HTTPError(request.full_url, 429, "Too Many Requests", {},
                    io.BytesIO(json.dumps({"error": {"details": [{"retryDelay": "3600s"}]}}).encode()))
            return self.response()
        with patch("translation.urllib.request.urlopen", urlopen):
            with self.assertRaises(TranslationBusyError) as error:
                generate("same-model", [], "test", track="screen")
            self.assertEqual(error.exception.retry_after, 3600)
            with self.assertRaises(TranslationBusyError):
                generate("same-model", [], "another frame", track="screen")
            self.assertEqual(generate("same-model", [], "test"), "Hello")
        self.assertEqual(keys, ["key-screen", "key-audio"])

    def test_identical_requests_use_cache_and_usage_counts_only_network(self):
        with patch("translation.urllib.request.urlopen", side_effect=lambda *a, **k: self.response()) as request:
            for _ in range(10):
                self.assertEqual(generate(CAPTION_TRANSLATION_MODEL, [{"text": "bonjour"}], "translate"), "Hello")
        self.assertEqual(request.call_count, 1)
        usage = usage_snapshot()["audio"]
        self.assertEqual((usage["requests"], usage["cache_hits"], usage["input_tokens"]), (1, 9, 40))

    def test_timeout_becomes_track_local_backoff(self):
        with patch("translation.urllib.request.urlopen", side_effect=TimeoutError()) as request:
            for _ in range(3):
                with self.assertRaises(TranslationBusyError):
                    generate("test", [], "test")
        self.assertEqual(request.call_count, 1)

    def test_bad_credentials_are_not_retried_until_key_changes(self):
        with patch("translation.urllib.request.urlopen", side_effect=HTTPError("test", 403, "Forbidden", {}, io.BytesIO())) as request:
            for _ in range(3):
                with self.assertRaises(ValueError):
                    generate("test", [], "test")
        self.assertEqual(request.call_count, 1)
        with patch("translation.service_key", return_value="changed-key"), \
             patch("translation.urllib.request.urlopen", return_value=self.response()) as request:
            self.assertEqual(generate("test", [], "test"), "Hello")
            self.assertEqual(request.call_count, 1)

    def test_retry_info_and_daily_limits_are_not_capped_at_sixty_seconds(self):
        detail = {"code": 429, "details": [{"retryDelay": "62876s"}]}
        self.assertEqual(retry_delay(detail, {"Retry-After": "30"}), 62876)
        self.assertEqual(cloud_error(detail).retry_after, 62876)
        self.assertEqual(retry_delay({"details": [{"violations": [{"quotaId": "RequestsPerDayPerProject"}]}]}), 86400)


if __name__ == "__main__":
    unittest.main()
