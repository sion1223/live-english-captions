"""Download only the small English model files required for local streaming."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models" / "zipformer-en-20m"
BASE_URL = "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/"
FILES = (
    "encoder-epoch-99-avg-1.int8.onnx",
    "decoder-epoch-99-avg-1.onnx",
    "joiner-epoch-99-avg-1.int8.onnx",
    "tokens.txt",
)


def download(name):
    target = MODEL_DIR / name
    if target.exists() and target.stat().st_size:
        return
    temporary = target.with_suffix(target.suffix + ".part")
    print(f"Downloading {name}...", flush=True)
    with urllib.request.urlopen(BASE_URL + name, timeout=90) as response:
        with temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
    temporary.replace(target)
    print(f"Ready: {name} ({target.stat().st_size / 1048576:.1f} MB)", flush=True)


if __name__ == "__main__":
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(download, FILES))
    print("English model ready.")
