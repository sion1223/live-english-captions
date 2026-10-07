"""Persist API credentials per Windows user, never in the page or extension."""
import json
import os
import re
from pathlib import Path
from threading import RLock

SETTINGS_FILE = Path(os.getenv("LOCALAPPDATA") or Path.home() / ".config") / "LiveEnglishCaptions" / "settings.json"
LEGACY_SETTINGS_FILE = Path(__file__).resolve().parent / ".run" / "gemini-settings.json"
GEMINI_MODEL = os.getenv("GEMINI_TRANSCRIBE_MODEL", "gemini-3.5-transcribe-live")
CAPTION_TRANSLATION_MODEL = os.getenv("GEMINI_CAPTION_TRANSLATION_MODEL", "gemini-3.1-flash-lite")
SCREEN_TRANSLATION_MODEL = os.getenv("GEMINI_SCREEN_TRANSLATION_MODEL",
                                     os.getenv("GEMINI_TRANSLATION_MODEL", "gemini-3.5-flash-lite"))
SETTINGS_LOCK = RLock()
FACTCHAT_BASE_URL = "https://factchat.mindlogic-kr-api.com/v1/gateway"
FACTCHAT_TRANSCRIBE_MODEL = "stt-rt-v5"
PROVIDER_VARIABLES = {
    "audio": "CAPTION_TRANSLATION_PROVIDER",
    "screen": "SCREEN_TRANSLATION_PROVIDER",
    "transcription": "TRANSCRIPTION_PROVIDER",
}


def read_settings(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def read_key(path, field="api_key"):
    value = read_settings(path).get(field, "")
    return value.strip() if isinstance(value, str) else ""


def factchat_key():
    return read_key(SETTINGS_FILE, "factchat_api_key") or os.getenv("BAZE_API_KEY", "")


def service_provider(track):
    if track not in PROVIDER_VARIABLES:
        raise ValueError("Unknown API track.")
    provider = os.getenv(PROVIDER_VARIABLES[track]) or read_settings(SETTINGS_FILE).get(track + "_provider", "google")
    if provider not in ("google", "factchat"):
        raise ValueError("Unknown API provider: " + str(provider))
    return provider


def service_key(track):
    if service_provider(track) == "factchat":
        return factchat_key()
    return gemini_key("audio" if track == "transcription" else track)


def save_service_key(value, track="audio"):
    # The existing audio key field controls transcription; Google credentials
    # remain stored separately when a shared gateway key is selected.
    selected = "transcription" if track == "audio" else track
    if service_provider(selected) != "factchat":
        return save_gemini_key(value, track)
    value = str(value).strip()
    if not value.startswith("baze_") or not 20 <= len(value) <= 256 or any(char.isspace() for char in value):
        raise ValueError("FactChat API 키 형식을 확인해 주세요.")
    with SETTINGS_LOCK:
        values = read_settings(SETTINGS_FILE)
        values["factchat_api_key"] = value
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(values), encoding="utf-8")
        temporary.replace(SETTINGS_FILE)


def gemini_key(track="audio"):
    if track == "screen":
        # Never silently spend the audio track's quota on image requests.
        return read_key(SETTINGS_FILE, "screen_api_key") or os.getenv("GEMINI_SCREEN_API_KEY") or ""
    if track != "audio":
        raise ValueError("Unknown API key track.")
    saved = read_key(SETTINGS_FILE)
    if not saved:
        saved = read_key(LEGACY_SETTINGS_FILE)
        if saved:
            try:
                save_gemini_key(saved)
                LEGACY_SETTINGS_FILE.unlink(missing_ok=True)
            except (OSError, ValueError):
                pass  # A read-only install can still use its existing key.
    return saved or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""


def save_gemini_key(value, track="audio"):
    if track not in ("audio", "screen"):
        raise ValueError("Unknown API key track.")
    value = str(value).strip()
    if not 20 <= len(value) <= 256 or any(character.isspace() for character in value):
        raise ValueError("Gemini API 키 형식을 확인해 주세요.")
    with SETTINGS_LOCK:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        values = read_settings(SETTINGS_FILE)
        values["screen_api_key" if track == "screen" else "api_key"] = value
        temporary = SETTINGS_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(values), encoding="utf-8")
        temporary.replace(SETTINGS_FILE)


def safe_error(error):
    text = str(error)
    for key in (gemini_key(), gemini_key("screen"), factchat_key()):
        if key:
            text = text.replace(key, "[redacted]")
    return re.sub(r"AIza[0-9A-Za-z_-]{25,}|baze_[0-9A-Za-z_-]+", "[redacted]", text)[:800]
