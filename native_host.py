"""Chrome native messaging bridge for starting this project's local server."""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
HOST_NAME = "com.live_english_captions.launcher"
RUN = ROOT / ".run"
VERSION = 5


def extension_id():
    # Chromium hashes the absolute unpacked path (UTF-16 on Windows).
    path = str(ROOT / "extension")
    if os.name == "nt":
        path = path[0].upper() + path[1:]
    digest = hashlib.sha256(path.encode("utf-16-le" if os.name == "nt" else "utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


def install():
    import winreg
    # Microsoft Store Python can virtualize AppData writes, hiding the manifest
    # from Chrome. Keep the browser-facing file beside the installed project.
    destination = RUN
    destination.mkdir(parents=True, exist_ok=True)
    manifest = destination / "native-host.json"
    manifest.write_text(json.dumps({
        "name": HOST_NAME,
        "description": "Start Live English Captions on demand",
        "path": str(ROOT / "native-host.cmd"),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id()}/"],
    }, indent=2), encoding="utf-8")
    for browser in ("Google\\Chrome", "Microsoft\\Edge", "Chromium", "Google\\ChromeForTesting"):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"Software\\{browser}\\NativeMessagingHosts\\{HOST_NAME}") as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))
    print(f"Automatic launcher installed for extension {extension_id()}.")


def health():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=1) as response:
            result = json.load(response)
    except urllib.error.URLError as error:
        if isinstance(error, urllib.error.HTTPError):
            raise RuntimeError("Port 8765 belongs to another application.") from None
        return None
    except (TimeoutError, OSError):
        return None
    except ValueError:
        raise RuntimeError("Port 8765 belongs to another application.") from None
    if result.get("app") != "live-english-captions":
        raise RuntimeError("Port 8765 belongs to another application.")
    if result.get("protocol_version", 0) < VERSION:
        raise RuntimeError("An older caption server is running. Run stop.ps1 once, then click Start again.")
    return result


def ensure_server():
    import msvcrt
    RUN.mkdir(exist_ok=True)
    # Serialize simultaneous popup/key-save/start requests across host processes.
    with (RUN / "launcher.lock").open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        try:
            if ready := health():
                return ready
            python = ROOT / ".venv" / "Scripts" / "python.exe"
            if not python.is_file():
                raise RuntimeError("Run setup.ps1 once to install the caption runtime.")
            with (RUN / "server.log").open("ab") as output, (RUN / "server-error.log").open("ab") as errors:
                process = subprocess.Popen(
                    [str(python), "-u", str(ROOT / "server.py")], cwd=ROOT,
                    stdin=subprocess.DEVNULL, stdout=output, stderr=errors,
                    creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
                    env={**os.environ, "PYTHONUTF8": "1"},
                    close_fds=True,
                )
            (RUN / "server.pid").write_text(str(process.pid), encoding="ascii")
            for _ in range(60):
                if process.poll() is not None:
                    raise RuntimeError("Caption server could not start. See .run/server-error.log.")
                if ready := health():
                    return ready
                time.sleep(0.2)
            raise RuntimeError("Caption server startup timed out. See .run/server-error.log.")
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def read_message(stream):
    header = stream.read(4)
    if len(header) != 4:
        raise ValueError("Missing native message header.")
    size = struct.unpack("<I", header)[0]
    if size > 4096:
        raise ValueError("Native message is too large.")
    payload = stream.read(size)
    if len(payload) != size:
        raise ValueError("Incomplete native message.")
    return json.loads(payload)


def main():
    if sys.argv[1:] == ["--install"]:
        install()
        return
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        origin = f"chrome-extension://{extension_id()}/"
        if len(sys.argv) < 2 or sys.argv[1] != origin:
            raise ValueError("Unexpected extension origin.")
        request = read_message(sys.stdin.buffer)
        if request != {"action": "ensure_server"}:
            raise ValueError("Unknown launcher action.")
        result = {"ok": True, "health": ensure_server()}
    except Exception as error:
        result = {"ok": False, "error": str(error)[:300]}
    payload = json.dumps(result).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)) + payload)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
