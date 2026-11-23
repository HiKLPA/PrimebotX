#!/usr/bin/env python3
"""Start PrimebotX locally with one cross-platform command."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "log"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start PrimebotX")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "8080")),
        help="backend port (default: PORT or 8080)",
    )
    parser.add_argument(
        "--ai-port",
        type=int,
        default=int(os.environ.get("AI_PORT", "8091")),
        help="AI service port (default: AI_PORT or 8091)",
    )
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    return parser.parse_args()


def python_executable() -> Path:
    candidates = [
        ROOT / ".venv" / "Scripts" / "python.exe",
        ROOT / ".venv" / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return Path(sys.executable)


def backend_executable() -> Path:
    candidates = [
        ROOT / "backend-build" / "primebotx_backend.exe",
        ROOT / "backend-build" / "primebotx_backend",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "backend executable not found; run scripts/fetch_deps.sh and "
        "scripts/build_backend.sh first"
    )


def start_process(args: list[str], *, log_path: Path | None = None) -> subprocess.Popen:
    stdout = subprocess.PIPE
    stderr = subprocess.STDOUT
    log_file = None
    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_file = log_path.open("w", encoding="utf-8")
        stdout = log_file
    process = subprocess.Popen(
        args,
        cwd=ROOT,
        stdout=stdout,
        stderr=stderr,
        text=True,
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    process._primebotx_log_file = log_file  # type: ignore[attr-defined]
    return process


def health(url: str, validator) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return validator(json.load(response))
    except (OSError, ValueError, urllib.error.URLError):
        return False


def wait_until_ready(
    process: subprocess.Popen,
    url: str,
    validator,
    timeout_seconds: float = 20.0,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"process exited with code {process.returncode}")
        if health(url, validator):
            return
        time.sleep(0.25)
    raise TimeoutError(f"service did not become ready: {url}")


def stop_process(process: subprocess.Popen | None) -> None:
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    log_file = getattr(process, "_primebotx_log_file", None)
    if log_file is not None:
        log_file.close()


def show_log(path: Path) -> None:
    if not path.is_file():
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if lines:
        print(f"\nLast lines from {path}:")
        print("\n".join(lines[-20:]))


def main() -> int:
    args = parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.ai_port <= 65535:
        raise ValueError("ports must be between 1 and 65535")
    if args.port == args.ai_port:
        raise ValueError("--port and --ai-port must be different")

    python = python_executable()
    backend = backend_executable()
    ai_script = ROOT / "backend" / "ai" / "deepseek_bridge.py"
    frontend = ROOT / "frontend"
    database = ROOT / "data" / "primebotx.db"
    if not ai_script.is_file():
        raise FileNotFoundError(f"AI service not found: {ai_script}")
    if not frontend.is_dir():
        raise FileNotFoundError(f"frontend directory not found: {frontend}")
    database.parent.mkdir(parents=True, exist_ok=True)

    backend_url = f"http://127.0.0.1:{args.port}"
    ai_url = f"http://127.0.0.1:{args.ai_port}"
    page_url = f"{backend_url}/ui/PrimebotX.html"
    ai_log = LOG_DIR / "ai.log"
    ai_process: subprocess.Popen | None = None
    backend_process: subprocess.Popen | None = None

    try:
        ai_ready = health(f"{ai_url}/health", lambda value: bool(value.get("ok")))
        if not ai_ready:
            print("Starting AI service...")
            ai_process = start_process(
                [str(python), str(ai_script), "--port", str(args.ai_port)],
                log_path=ai_log,
            )
            try:
                wait_until_ready(
                    ai_process,
                    f"{ai_url}/health",
                    lambda value: bool(value.get("ok")),
                )
            except Exception:
                show_log(ai_log)
                raise
        else:
            print(f"Using AI service at {ai_url}")

        backend_ready = health(
            f"{backend_url}/api/v1/health",
            lambda value: value.get("data", {}).get("service") == "primebotx_backend",
        )
        if not backend_ready:
            print("Starting backend...")
            backend_process = start_process(
                [
                    str(backend),
                    "--port",
                    str(args.port),
                    "--web-root",
                    str(frontend),
                    "--db-path",
                    str(database),
                    "--ai-url",
                    ai_url,
                ],
                log_path=LOG_DIR / "backend.log",
            )
            try:
                wait_until_ready(
                    backend_process,
                    f"{backend_url}/api/v1/health",
                    lambda value: value.get("data", {}).get("service")
                    == "primebotx_backend",
                )
            except Exception:
                show_log(LOG_DIR / "backend.log")
                raise
        else:
            print(f"Using backend at {backend_url}")

        print(f"\nPrimebotX is ready: {page_url}")
        if not args.no_browser:
            webbrowser.open(page_url)

        if ai_process is None and backend_process is None:
            return 0

        print("Press Ctrl+C to stop the services started by this command.")
        while True:
            for name, process in (
                ("backend", backend_process),
                ("AI service", ai_process),
            ):
                if process is not None and process.poll() is not None:
                    raise RuntimeError(
                        f"{name} stopped with code {process.returncode}"
                    )
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nStopping PrimebotX...")
        return 0
    except Exception as error:
        print(f"\nStartup failed: {error}", file=sys.stderr)
        return 1
    finally:
        stop_process(backend_process)
        stop_process(ai_process)


if __name__ == "__main__":
    raise SystemExit(main())
