"""DSP regression checks without opening any audio device."""
import importlib.util
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'lib'))
spec = importlib.util.spec_from_file_location('capture', Path(__file__).parents[1] / 'lib' / 'capture.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class AnalyserTests(unittest.TestCase):
    def test_antiphase_stereo_keeps_energy(self):
        t = np.arange(2048) / 48000
        sine = 0.5 * np.sin(2 * np.pi * 1000 * t)
        mono = capture.Analyser(48000, 24).push(sine)
        stereo = capture.Analyser(48000, 24).push(np.column_stack([sine, -sine]))
        self.assertAlmostEqual(stereo['rms'], mono['rms'], places=1)
        self.assertEqual(stereo['bands'], mono['bands'])
        self.assertGreater(stereo['rms'], -12)

    def test_window_profiles_and_nyquist(self):
        for rate in [8000, 44100, 48000, 192000]:
            for window in [1024, 2048, 4096]:
                with self.subTest(rate=rate, window=window):
                    analyser = capture.Analyser(rate, 48, window)
                    frame = analyser.push(np.zeros((window, 2)))
                    self.assertEqual(len(frame['bands']), 48)
                    self.assertTrue(np.isfinite(frame['bands']).all())
                    self.assertTrue(all(0 <= a < b <= window // 2 + 1 for a, b in analyser.spans))

    def test_stream_matches_whole_window(self):
        rng = np.random.default_rng(4)
        audio = rng.standard_normal((2048, 2)) * 0.1
        streamed = capture.Analyser(48000, 24)
        for block in np.array_split(audio, 8):
            frame = streamed.push(block)
        whole = capture.Analyser(48000, 24).push(audio)
        self.assertEqual(frame['bands'], whole['bands'])
        self.assertEqual(frame['rms'], whole['rms'])

    def test_silence_hold_then_recovery(self):
        analyser = capture.Analyser(48000, 24)
        with patch.object(capture.time, 'monotonic', return_value=10):
            self.assertFalse(analyser.push(np.zeros(2048))['idle'])
        with patch.object(capture.time, 'monotonic', return_value=12):
            self.assertTrue(analyser.push(np.zeros(2048))['idle'])
            self.assertFalse(analyser.push(np.ones(2048) * 0.1)['idle'])


if __name__ == '__main__':
    unittest.main()
