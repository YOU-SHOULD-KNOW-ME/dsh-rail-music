#!/usr/bin/env python3
"""
dsh-rail-music — capture helper
==============================

Captures system audio through WASAPI loopback (Windows), a sink monitor
(Linux), or a routed virtual input (macOS), and writes frames to **stdout**, one line per
frame. The DSH host plugin spawns this process and owns its lifetime; nothing
here listens on a socket, so the feature needs no port of its own.

stdout protocol — one JSON object per line, ~`--fps` lines per second:

    {"rms": -21.3, "peak": -7.8, "bands": [-38.1, ...], "beat": 3, "idle": false}

`bands` are dBFS-ish (0 = full scale), lowest frequency first. Adaptive gain and
the envelope follower live in the browser half, so nothing here needs tuning to
whatever is currently playing.

stderr carries diagnostics only. A fatal startup failure is one JSON object on
stderr and a non-zero exit, so the host can report the real reason instead of
"helper exited".
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import threading
import time
from collections import deque
from typing import Any

import numpy as np
from audio_devices import backend_name, list_devices, select_endpoint

# 2048 frames at 48 kHz gives ~23 Hz bins: fine enough to separate a bass line
# from a kick drum, where 1024 would smear them into one band.
WINDOW = 2048
BAND_LO_HZ = 30.0
BAND_HI_HZ = 16000.0
DB_FLOOR = -90.0

# A band needs this much level above its own recent average to count as an onset.
ONSET_DB = 5.0
ONSET_REFRACTORY_S = 0.13
SILENCE_DB = -58.0
SILENCE_HOLD_S = 1.5


def db(amplitude: float) -> float:
    """Linear amplitude to dBFS, floored so the JSON stays finite."""
    return max(DB_FLOOR, 20.0 * math.log10(amplitude + 1e-12))


def band_slices(rate: int, count: int, window: int = WINDOW) -> list[tuple[int, int]]:
    """Log-spaced FFT bin ranges, lowest frequency first."""
    freqs = np.fft.rfftfreq(window, 1.0 / rate)
    edges = np.geomspace(BAND_LO_HZ, min(BAND_HI_HZ, rate / 2), count + 1)
    indexes = np.searchsorted(freqs, edges)
    spans: list[tuple[int, int]] = []
    for i in range(count):
        start = int(indexes[i])
        stop = max(start + 1, int(indexes[i + 1]))
        spans.append((start, min(stop, len(freqs))))
    return spans


class Analyser:
    """Sliding-window FFT over the loopback stream, one frame per hop."""

    def __init__(self, rate: int, bands: int, window: int = WINDOW) -> None:
        self.size = window
        self.spans = band_slices(rate, bands, window)
        self.window = np.hanning(window).astype(np.float64)
        self.window_sum = float(self.window.sum())
        self.buffer = np.zeros((window, 1), dtype=np.float64)
        self.filled = 0
        # Rolling history backs both onset detection and the client's AGC anchor.
        self.recent: deque[float] = deque(maxlen=90)
        self.last_onset = 0.0
        self.beat = 0
        self.silent_since: float | None = None

    def push(self, block: np.ndarray) -> dict[str, Any] | None:
        """Consume one block; returns a frame once the window has filled."""
        count = len(block)
        if count == 0:
            return None
        if block.ndim == 1:
            block = block[:, None]
        if self.buffer.shape[1] != block.shape[1]:
            self.buffer = np.zeros((self.size, block.shape[1]), dtype=np.float64)
            self.filled = 0
        if count >= self.size:
            self.buffer[:] = block[-self.size:]
            self.filled = self.size
        else:
            self.buffer[:-count] = self.buffer[count:]
            self.buffer[-count:] = block
            self.filled = min(self.size, self.filled + count)
        if self.filled < self.size:
            return None
        return self.analyse()

    def analyse(self) -> dict[str, Any]:
        # Combine channel POWER, not samples: L=-R must remain audible here.
        channels = np.abs(np.fft.rfft(self.buffer * self.window[:, None], axis=0))
        spectrum = np.sqrt(np.mean(channels * channels, axis=1))
        # 2/sum(w) puts a full-scale sine at 0 dB, so values read as dBFS.
        scale = 2.0 / self.window_sum
        bands: list[float] = []
        for start, stop in self.spans:
            chunk = spectrum[start:stop]
            bands.append(round(db(math.sqrt(2.0 * float(np.dot(chunk, chunk))) * scale), 1))

        rms_db = db(math.sqrt(float(np.mean(self.buffer * self.buffer))))
        peak_db = db(float(np.max(np.abs(self.buffer))))
        now = time.monotonic()

        bass = float(np.mean(bands[: max(1, len(bands) // 3)]))
        self.recent.append(bass)
        if len(self.recent) >= 20:
            if bass - float(np.mean(self.recent)) >= ONSET_DB and (now - self.last_onset) >= ONSET_REFRACTORY_S:
                self.beat += 1
                self.last_onset = now

        if rms_db < SILENCE_DB:
            if self.silent_since is None:
                self.silent_since = now
        else:
            self.silent_since = None
        silent_for = 0.0 if self.silent_since is None else now - self.silent_since

        return {
            "rms": round(rms_db, 1),
            "peak": round(peak_db, 1),
            "bands": bands,
            "beat": self.beat,
            "idle": silent_for >= SILENCE_HOLD_S,
            # Emission time on Python's monotonic clock (QPC on modern Windows,
            # comparable between Python processes on this machine). Lets a
            # diagnostic split capture latency from transport latency instead of
            # guessing which half to optimise.
            "tm": time.monotonic(),
        }


# Set by --log; diagnostics are appended here as well as to stderr, because the
# Host only keeps the most recent stderr line and a crash loop is invisible in
# a single line.
_LOG: Any = None


def note(message: str) -> None:
    """Append one diagnostic line to stderr and, when configured, the log file."""
    stamped = f"{time.strftime('%H:%M:%S')} {message}"
    try:
        print(json.dumps({"diagnostic": stamped}), file=sys.stderr, flush=True)
    except OSError:
        pass
    if _LOG is not None:
        try:
            _LOG.write(stamped + "\n")
            _LOG.flush()
        except OSError:
            pass


def fail(message: str) -> None:
    """Report a failure: one JSON line on stderr, plus the log file."""
    note(f"ERROR {message}")
    try:
        print(json.dumps({"error": message}), file=sys.stderr, flush=True)
    except OSError:
        pass


def watch_parent() -> None:
    """
    Exit as soon as the Host closes our stdin.

    Armed only under `--watch-parent`, because it is only meaningful when stdin
    is a pipe the Host holds open and never writes to. Any other stdin (NUL from
    `stdio: 'ignore'`, a closed handle, a terminal) reads EOF immediately, which
    would make the helper exit the instant it started.
    """
    try:
        while sys.stdin.buffer.read(1):
            pass
    except Exception:  # noqa: BLE001 - any stdin failure means the same thing
        pass
    note("stdin closed by the Host; exiting")
    os._exit(0)


def main() -> int:
    global _LOG

    parser = argparse.ArgumentParser(description="dsh-rail-music capture helper")
    parser.add_argument("--device", default=None, help="output/monitor ID or name; macOS: routed virtual input")
    parser.add_argument("--list-devices", action="store_true", help="print capture endpoints as JSON and exit")
    parser.add_argument("--rate", type=int, default=48000)
    parser.add_argument("--fps", type=float, default=60.0)
    parser.add_argument("--bands", type=int, default=24)
    parser.add_argument("--window", type=int, choices=[1024, 2048, 4096], default=WINDOW)
    parser.add_argument("--log", default=None, help="append diagnostics to this file")
    parser.add_argument("--watch-parent", action="store_true",
                        help="exit when stdin closes; requires the Host to hold stdin open as a pipe")
    args = parser.parse_args()
    if not 8000 <= args.rate <= 192000 or not 10 <= args.fps <= 120 or not 3 <= args.bands <= 48:
        parser.error("rate must be 8000..192000, fps 10..120, bands 3..48")

    if args.log:
        try:
            _LOG = open(args.log, "a", encoding="utf-8", buffering=1)
        except OSError:
            _LOG = None

    note(f"start pid={os.getpid()} rate={args.rate} fps={args.fps} bands={args.bands} device={args.device!r}")

    if args.watch_parent:
        note("watching stdin for Host exit")
        threading.Thread(target=watch_parent, daemon=True).start()

    try:
        backend_name(sys.platform)
        import soundcard as sc
    except Exception as error:  # noqa: BLE001 - the message is the whole point
        hint = 'Install NumPy/SoundCard with this Python interpreter.'
        if sys.platform == 'linux':
            hint += ' Ensure libpulse is installed and PulseAudio or pipewire-pulse is running in the same user session.'
        fail(f"audio backend unavailable ({error}); {hint}")
        return 2

    if args.list_devices:
        try:
            print(json.dumps(list_devices(sc, sys.platform)), flush=True)
            return 0
        except Exception as error:
            fail(f"cannot list audio devices: {error}")
            return 2

    hop = max(128, int(round(args.rate / max(1.0, args.fps))))
    emitted = 0
    while True:
        try:
            endpoint = select_endpoint(sc, sys.platform, args.device)
            recorder_context = endpoint.recorder(args.rate, hop)
            analyser = Analyser(args.rate, args.bands, args.window)
            next_device_check = time.monotonic() + 1.0
            with recorder_context as recorder:
                info = endpoint.info()
                note(f"capture open: {info['backend']} device={info['deviceId']}")
                try:
                    print(json.dumps({"ready": True, "capture": info}), file=sys.stderr, flush=True)
                except OSError:
                    return 0
                while True:
                    block = recorder.record(numframes=hop)
                    if time.monotonic() >= next_device_check:
                        next_device_check = time.monotonic() + 1.0
                        if endpoint.output_changed(sc):
                            note("default output changed; reopening loopback")
                            break
                    frame = analyser.push(np.asarray(block, dtype=np.float64))
                    if frame is None:
                        continue
                    # One line per frame, flushed immediately: this stream feeds
                    # a 60 fps animation, so batching frames into 8 KB pipe
                    # blocks would arrive as visible bursts.
                    sys.stdout.write(json.dumps(frame) + "\n")
                    sys.stdout.flush()
                    emitted += 1
        except KeyboardInterrupt:
            note(f"interrupted after {emitted} frames")
            return 0
        except BrokenPipeError:
            # The Host went away mid-frame; there is nobody left to serve.
            note(f"stdout closed by the Host after {emitted} frames; exiting")
            return 0
        except Exception as error:  # noqa: BLE001 - a device change must not kill the plugin
            fail(f"capture failed ({type(error).__name__}: {error}); retrying")
            time.sleep(2.0)


if __name__ == "__main__":
    raise SystemExit(main())
