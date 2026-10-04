"""Real Linux null-sink capture test; run with a local PulseAudio server.

The output sink must be rail_ci, so this never plays the test tone through a
user's speakers. GitHub's Linux capture job prepares that sink.
"""
import json
from pathlib import Path
import subprocess
import sys
import threading
import time

import numpy as np
import soundcard as sc

if sys.platform != 'linux' or sc.default_speaker().id != 'rail_ci':
    raise SystemExit('Requires Linux with rail_ci as the default PulseAudio null sink')

helper = Path(__file__).parents[1] / 'lib' / 'capture.py'
process = subprocess.Popen([sys.executable, '-u', str(helper), '--watch-parent', '--fps', '80'],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True)
frames = []
reports = []

def pump(pipe, target):
    for line in pipe:
        try:
            target.append(json.loads(line))
        except json.JSONDecodeError:
            pass

threading.Thread(target=pump, args=(process.stdout, frames), daemon=True).start()
threading.Thread(target=pump, args=(process.stderr, reports), daemon=True).start()
try:
    deadline = time.monotonic() + 10
    while not frames and time.monotonic() < deadline and process.poll() is None:
        time.sleep(.05)
    assert frames, f'helper produced no frames: {reports}'
    t = np.arange(48000 * 2) / 48000
    tone = .2 * np.sin(2 * np.pi * 440 * t)
    sc.default_speaker().play(np.column_stack([tone, tone]).astype(np.float32), samplerate=48000)
    time.sleep(.25)
    assert max(frame['rms'] for frame in frames) > -30, 'monitor must receive the null-sink tone'
    ready = next(report for report in reports if report.get('ready'))
    assert ready['capture']['backend'] == 'pulseaudio-monitor'
    assert ready['capture']['deviceId'] == 'rail_ci.monitor'
    assert process.poll() is None, 'helper exited during capture'
    print(f"PASS Linux real null-sink capture: {len(frames)} frames, peak RMS {max(x['rms'] for x in frames):.1f} dB")
finally:
    process.stdin.close()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
assert process.returncode == 0, 'parent EOF must stop the helper cleanly'
print('PASS Linux helper exits after parent stdin closes')
