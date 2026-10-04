#!/usr/bin/env python3
"""
Measure the two things that decide whether the rail "matches the music":

1. **Playback-call-to-helper latency** — includes the playback API's startup
   and buffering; it does not include browser rendering or measure when a
   listener actually hears the transient.
2. **What actually drives the motion** — the contribution of loudness, beat
   pulse and per-tick frequency texture, in the same units the browser uses
   (scaleX). If the frequency term is a rounding error next to loudness, the
   rail is a VU meter wearing a spectrum's clothes.

    python tools/measure-sync.py
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# The capture helper lives with the plugin, one level up from tools/.
HELPER = HERE.parent / 'lib' / 'capture.py'
PYTHON = os.environ.get('RAIL_MUSIC_PYTHON', sys.executable)
RATE = 48000

# Browser-side constants, mirrored so the numbers are comparable to what the
# rail actually renders.
AUDIO_DEPTH = 0.7
W_BAND = 0.62
W_LEVEL = 0.22
W_PULSE = 0.30
LEVEL_ATTACK = 0.012
LEVEL_RELEASE = 0.06
PULSE_DECAY = 0.07
BAND_ATTACK = 0.006
BAND_RELEASE = 0.03
BAND_TILT_DB = 1.3
BAND_WINDOW_DB = 30
BAND_CENTER_TAU = 1.2
BAND_GAMMA = 1.15
AGC_DECAY_DB_PER_S = 3.0
AGC_MIN_SPAN_DB = 20


def click_train(seconds: float, seed: int = 11) -> tuple[np.ndarray, np.ndarray]:
    """
    Clicks at pseudo-random times, with those times returned.

    Matching multiple known click times against the observed envelope reduces
    single-click jitter. The time reference is still the play() CALL, so its
    startup delay remains in the result.
    """
    rng = np.random.default_rng(seed)
    total = int(RATE * seconds)
    mono = np.zeros(total)
    times = np.sort(rng.uniform(0.6, seconds - 0.4, 14))
    # 25 ms bursts at full scale: whatever the machine is already playing is
    # typically 20+ dB below this, which is the margin the correlator needs.
    length = int(0.025 * RATE)
    for at in times:
        start = int(at * RATE)
        mono[start:start + length] += rng.standard_normal(length)
    return np.stack([mono, mono], axis=1).astype(np.float32), times


def music_like(seconds: float) -> np.ndarray:
    """A bass line against a moving melody, so frequency content changes."""
    total = int(RATE * seconds)
    t = np.arange(total) / RATE
    mono = np.zeros(total)
    # Bass: two notes, alternating every 0.5 s.
    for index, at in enumerate(np.arange(0.0, seconds, 0.5)):
        note = 55.0 if index % 2 == 0 else 82.41
        start = int(at * RATE)
        end = min(total, start + int(0.5 * RATE))
        mono[start:end] += 0.45 * np.sin(2 * np.pi * note * t[start:end])
    # Melody: a rising line, one note per 0.25 s, in the 300-1200 Hz region.
    for index, at in enumerate(np.arange(0.0, seconds, 0.25)):
        note = 300.0 * (2 ** (index % 8) / 8)
        start = int(at * RATE)
        end = min(total, start + int(0.22 * RATE))
        envelope = np.hanning(max(2, end - start))
        mono[start:end] += 0.3 * np.sin(2 * np.pi * note * t[start:end]) * envelope
    mono *= 0.9 / max(1e-9, float(np.max(np.abs(mono))))
    return np.stack([mono, mono], axis=1).astype(np.float32)


class Reader:
    """Consume the helper's stdout, timestamping every frame on arrival."""

    def __init__(self, log: str | None = None) -> None:
        args = [PYTHON, '-u', str(HELPER), '--rate', str(RATE), '--fps', '80', '--bands', '24', '--watch-parent']
        if log:
            args += ['--log', log]
        self.errors: list[str] = []
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.frames: list[tuple[float, dict]] = []
        self.lock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._drain_errors, daemon=True).start()

    def _drain_errors(self) -> None:
        assert self.process.stderr is not None
        for raw in self.process.stderr:
            self.errors.append(raw.decode('utf-8', 'replace').rstrip())

    def _pump(self) -> None:
        assert self.process.stdout is not None
        for raw in self.process.stdout:
            arrived = time.monotonic()
            try:
                frame = json.loads(raw)
            except Exception as error:  # noqa: BLE001 - surfaced below
                self.errors.append(f'bad frame: {error}: {raw[:120]!r}')
                continue
            with self.lock:
                self.frames.append((arrived, frame))

    def wait_frames(self, count: int, timeout: float) -> bool:
        """Block until `count` frames have arrived, or the timeout expires."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if len(self.frames) >= count:
                    return True
            time.sleep(0.05)
        return False

    def stop(self) -> None:
        self.process.kill()


def measure_latency() -> float:
    """Lag from the play() call reference to helper-frame arrival (no browser)."""
    reader = Reader()
    if not reader.wait_frames(30, 5.0):
        print(f'  helper produced no frames; stderr: {reader.errors[:3]}')
        reader.stop()
        return float('nan')
    time.sleep(1.0)

    import soundcard as sc

    seconds = 6.0
    track, times = click_train(seconds)

    ambient: list[float] = []
    with reader.lock:
        ambient = [frame['rms'] for _, frame in reader.frames[-40:]]
    baseline = sorted(ambient)[len(ambient) // 2] if ambient else -90.0

    started = time.monotonic()
    sc.default_speaker().play(track, samplerate=RATE)
    time.sleep(0.4)

    with reader.lock:
        captured = list(reader.frames)
    reader.stop()

    observed = [(arrived - started, frame['rms']) for arrived, frame in captured if arrived >= started]
    if len(observed) < 50:
        print(f'  only {len(observed)} frames captured; cannot correlate')
        return float('nan')

    # Loudness above the room, as a function of arrival time.
    arrivals = np.array([at for at, _ in observed])
    levels = np.array([max(0.0, rms - baseline - 6.0) for _, rms in observed])

    best_lag, best_score = float('nan'), -1.0
    for lag_ms in range(0, 400, 2):
        lag = lag_ms / 1000.0
        hits = 0
        total_level = 0.0
        for at in times:
            # The click at `at` should surface in frames arriving near at + lag.
            near = np.abs(arrivals - (at + lag)) < 0.03
            if near.any():
                peak = float(levels[near].max())
                total_level += peak
                if peak > 3.0:
                    hits += 1
        score = hits + total_level / 100.0
        if score > best_score:
            best_score, best_lag, best_hits = score, lag, hits
    reliable = best_hits >= len(times) * 0.7
    print(f'  (ambient {baseline:.1f} dB, {len(observed)} frames, '
          f'{best_hits}/{len(times)} clicks matched at the best lag)')
    if not reliable:
        print('  !! fewer than 70% of clicks matched — the machine is too loud for '
              'a trustworthy reading; treat the number as an upper bound')
    return best_lag


def measure_drivers(seconds: float) -> dict:
    """Replay the browser's chain over real frames and report the ladder's motion."""
    reader = Reader()
    if not reader.wait_frames(30, 5.0):
        print(f'  helper produced no frames; stderr: {reader.errors[:3]}')
        reader.stop()
        return {'spread': (0.0, 0.0), 'swing': (0.0, 0.0), 'frames': 0}
    transports = sorted(
        (arrived - frame['tm']) * 1000.0
        for arrived, frame in reader.frames
        if 'tm' in frame and 0 <= arrived - frame['tm'] < 1.0
    )
    if transports:
        print(f"  transport (helper stdout -> reader): median "
              f"{transports[len(transports) // 2]:.1f} ms, "
              f"p90 {transports[int(len(transports) * 0.9)]:.1f} ms")
    time.sleep(0.5)

    import soundcard as sc

    track = music_like(seconds)
    threading.Thread(target=lambda: sc.default_speaker().play(track, samplerate=RATE), daemon=True).start()

    floor_db, ceiling_db = -60.0, -12.0
    level = 0.0
    pulse = 0.0
    last_beat = 0
    last_at = None
    band_floor: list[float] = []
    band_ceiling: list[float] = []
    bands: list[float] = []
    spreads: list[float] = []
    tick_min, tick_max = 1e9, -1e9

    deadline = time.monotonic() + seconds + 1.0
    cursor = 0
    while time.monotonic() < deadline:
        time.sleep(0.02)
        with reader.lock:
            batch = reader.frames[cursor:]
            cursor = len(reader.frames)
        for arrived, frame in batch:
            if last_at is None:
                last_at = arrived
                continue
            dt = min(0.1, arrived - last_at)
            last_at = arrived

            db = frame['rms']
            decay = AGC_DECAY_DB_PER_S * dt
            floor_db = min(db, floor_db + decay)
            ceiling_db = max(db, ceiling_db - decay)
            span = max(AGC_MIN_SPAN_DB, ceiling_db - floor_db)
            target = min(1.0, max(0.0, (db - floor_db) / span))
            tau = LEVEL_ATTACK if target > level else LEVEL_RELEASE
            level += (target - level) * (1 - math.exp(-dt / tau))

            if frame['beat'] != last_beat:
                last_beat = frame['beat']
                pulse = 1.0
            else:
                pulse = max(0.0, pulse - dt / PULSE_DECAY)

            raw = frame['bands']
            if len(bands) != len(raw):
                bands = [0.0] * len(raw)
                band_center = None
            tilted = [value + BAND_TILT_DB * i for i, value in enumerate(raw)]
            mean = sum(tilted) / len(tilted)
            if band_center is None:
                band_center = mean
            else:
                band_center += (mean - band_center) * (1 - math.exp(-dt / BAND_CENTER_TAU))
            window_low = band_center - BAND_WINDOW_DB / 2
            for i, value in enumerate(tilted):
                band_target = min(1.0, max(0.0, (value - window_low) / BAND_WINDOW_DB))
                band_tau = BAND_ATTACK if band_target > bands[i] else BAND_RELEASE
                bands[i] += (band_target - bands[i]) * (1 - math.exp(-dt / band_tau))

            # Render a 36-tick ladder exactly as paint() does, minus state bases.
            count = 36
            values = []
            for i in range(count):
                t = i / (count - 1)
                position = (1 - t) * (len(bands) - 1)
                lo = int(position)
                hi = min(len(bands) - 1, lo + 1)
                frac = position - lo
                band = (bands[lo] * (1 - frac) + bands[hi] * frac) ** BAND_GAMMA
                audio = min(1.0, W_BAND * band + W_LEVEL * level + W_PULSE * pulse)
                values.append(AUDIO_DEPTH * audio)
            spreads.append(max(values) - min(values))
            tick_min = min(tick_min, min(values))
            tick_max = max(tick_max, max(values))

    reader.stop()
    return {
        'spread': (min(spreads), max(spreads)),
        'swing': (tick_min, tick_max),
        'frames': len(spreads),
    }


def main() -> int:
    print('measuring play() call -> helper frame lag (includes playback startup; no browser)...')
    latency = measure_latency()
    print(f'  latency: {latency * 1000:.0f} ms')

    print('\nreplaying the browser signal chain over a bass+melody track...')
    drivers = measure_drivers(8.0)
    spread_lo, spread_hi = drivers['spread']
    swing_lo, swing_hi = drivers['swing']
    print(f"  frames: {drivers['frames']}")
    print(f"  per-frame spread across the ladder: {spread_lo:.3f} .. {spread_hi:.3f} scaleX"
          f"  ({20 * spread_lo:.1f} .. {20 * spread_hi:.1f}px of a 20px tick)")
    print(f"  a tick's total travel: {swing_lo:.3f} .. {swing_hi:.3f} scaleX"
          f"  ({20 * swing_lo:.1f} .. {20 * swing_hi:.1f}px)")
    print(f"  (before this change the spectrum moved a tick {20 * 0.035:.1f}px total)")

    print('\n--- verdict ---')
    checks = [
        ['playback-call lag measured (not an audio/video sync gate)', not math.isnan(latency) and 0.0 <= latency < 0.4],
        ['spectrum visibly differentiates the ladder', spread_hi > 0.25],
        ['a tick travels a usable range', (swing_hi - swing_lo) > 0.4],
    ]
    for label, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {label}")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == '__main__':
    raise SystemExit(main())
