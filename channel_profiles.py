"""Load reviewed, bounded channel vocabularies shared with the extension."""
from functools import lru_cache
import json
from pathlib import Path

PROFILES_FILE = Path(__file__).resolve().parent / "extension" / "channel-profiles.json"


@lru_cache(maxsize=1)
def load_profiles():
    document = json.loads(PROFILES_FILE.read_text(encoding="utf-8"))
    result = {}
    for profile in document["profiles"]:
        words = profile["vocabulary"]
        if not 1 <= len(words) <= 100:
            raise ValueError("Channel profiles must contain between 1 and 100 reviewed terms.")
        if any(not isinstance(word, str) or not word.strip() or len(word) > 80 or "\n" in word for word in words):
            raise ValueError("Invalid channel vocabulary.")
        if len({word.casefold() for word in words}) != len(words):
            raise ValueError("Duplicate channel vocabulary.")
        result[profile["id"]] = profile
    return result


def get_profile(profile_id):
    if not profile_id:
        return None
    if not isinstance(profile_id, str) or profile_id not in load_profiles():
        raise ValueError("Unknown channel profile.")
    return load_profiles()[profile_id]
