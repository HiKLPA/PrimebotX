"""Smoke-test the authenticated backend surface without optional services."""
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

with tempfile.TemporaryDirectory() as tmp:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    process = subprocess.Popen(
        [sys.argv[1], "--port", str(port), "--db-path", f"{tmp}/users.db"],
        stdout=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}/api/v1"

    def call(method, path):
        request = urllib.request.Request(
            base + path,
            data=b"{}" if method == "POST" else None,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        return response.status, json.load(response)

    try:
        for _ in range(100):
            try:
                if call("GET", "/health")[0] == 200:
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("server did not start")

        health = call("GET", "/health")[1]["data"]
        assert health["service"] == "primebotx_backend"
        assert "sim_enabled" not in health
        assert call("GET", "/auth/me")[0] == 401
        assert call("POST", "/chat")[0] == 401
        assert call("GET", "/sim/state")[0] == 401
        print("PASS: backend health and authenticated API boundary")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
