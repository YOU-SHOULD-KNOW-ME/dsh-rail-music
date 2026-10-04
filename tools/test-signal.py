#!/usr/bin/env python3
"""
Synthetic test track for dsh-rail-music.

Plays a short piece with a steady kick, a moving bass line, a chord pad and
hi-hats through the default render device, so the whole chain (loopback ->
bands -> SSE -> rail) can be verified without depending on whatever the music
player happens to be doing.

    python tools/test-signal.py --seconds 20
"""

from __future__ import annotations

import argparse
import numpy as np


def build(seconds: float, level: float, rate: int) -> np.ndarray:
    """One stereo buffer of a simple four-on-the-floor groove."""
    total = int(rate * seconds)
    t = np.arange(total) / rate
    mono = np.zeros(total, dtype=np.float64)

    def strike(at: float, decay: float, body: np.ndarray) -> None:
        """Mix one decaying body into the buffer, clipped to what still fits."""
        start = int(at * rate)
        if start >= total:
            return
        count = min(len(body), total - start)
        envelope = np.exp(-np.arange(count) / (decay * rate))
        mono[start:start + count] += body[:count] * envelope

    # Kick every half second: the onset detector's main input.
    for beat in np.arange(0.0, seconds, 0.5):
        length = int(rate * 0.25)
        sweep = np.sin(2 * np.pi * np.linspace(110, 45, length) * np.arange(length) / rate)
        strike(beat, 0.055, 0.9 * sweep)

    # Bass line, one note per bar of four beats.
    for index, beat in enumerate(np.arange(0.0, seconds, 2.0)):
        note = (55.0, 73.42, 82.41, 61.74)[index % 4]
        length = int(rate * 2.0)
        tone = np.sin(2 * np.pi * note * np.arange(length) / rate)
        strike(beat, 1.2, 0.35 * tone)

    # Chord pad: continuous mid content so the mid bands are never at the floor.
    for note in (220.0, 277.18, 329.63):
        mono += 0.05 * np.sin(2 * np.pi * note * t)
        mono += 0.02 * np.sin(2 * np.pi * note * 2 * t)

    # Hi-hats on the off beats: broadband treble.
    rng = np.random.default_rng(7)
    for beat in np.arange(0.25, seconds, 0.5):
        length = int(rate * 0.05)
        noise = rng.standard_normal(length)
        strike(beat, 0.012, 0.22 * noise)

    mono *= level / max(1e-9, float(np.max(np.abs(mono))))
    return np.stack([mono, mono], axis=1).astype(np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=20.0)
    parser.add_argument("--level", type=float, default=0.35, help="peak amplitude, 0..1")
    parser.add_argument("--rate", type=int, default=48000)
    args = parser.parse_args()

    import soundcard as sc

    buffer = build(args.seconds, args.level, args.rate)
    print(f"playing {args.seconds:.1f}s synthetic track at peak {args.level} on "
          f"{sc.default_speaker().name}", flush=True)
    sc.default_speaker().play(buffer, samplerate=args.rate)
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
