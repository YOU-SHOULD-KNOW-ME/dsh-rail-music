"""Platform routing tests; no hardware or SoundCard import is required."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).parents[1] / 'lib'))
from audio_devices import AudioSetupError, CaptureEndpoint, list_devices, select_endpoint


class Device:
    def __init__(self, id, name='', channels=2, loopback=False):
        self.id = id
        self.name = name
        self.channels = channels
        self.isloopback = loopback
        self.recorder = Mock(return_value='recorder')


def soundcard(speaker=None, inputs=None, speakers=None):
    sc = Mock()
    sc.default_speaker.return_value = speaker
    sc.all_microphones.return_value = inputs or []
    sc.all_speakers.return_value = speakers or ([speaker] if speaker else [])
    return sc


class DeviceRoutingTests(unittest.TestCase):
    def test_windows_default_does_not_read_friendly_name(self):
        class WindowsDevice:
            id = 'render-id'
            isloopback = True
            @property
            def name(self):
                raise AssertionError('friendly name must not be read')
            @property
            def channels(self):
                raise AssertionError('channel property store must not be read')
            recorder = Mock(return_value='recorder')
        device = WindowsDevice()
        sc = soundcard(device, [device])
        endpoint = select_endpoint(sc, 'win32')
        self.assertIs(endpoint.device, device)
        self.assertEqual(endpoint.info()['deviceName'], 'render-id')
        self.assertEqual(endpoint.recorder(48000, 600), 'recorder')
        device.recorder.assert_called_once_with(samplerate=48000, channels=2, blocksize=600)
        sc.get_microphone.assert_not_called()

    def test_linux_uses_default_sink_monitor_and_tracks_changes(self):
        sink = Device('alsa_output.test', 'Built-in audio')
        monitor = Device('alsa_output.test.monitor', 'Monitor of Built-in audio', loopback=True)
        mic = Device('alsa_input.mic', 'Microphone')
        sc = soundcard(sink, [mic, monitor])
        endpoint = select_endpoint(sc, 'linux')
        self.assertIs(endpoint.device, monitor)
        self.assertFalse(endpoint.output_changed(sc))
        sc.default_speaker.return_value = Device('new_sink')
        self.assertTrue(endpoint.output_changed(sc))

    def test_linux_explicit_sink_name_resolves_monitor(self):
        sink = Device('speaker_one', 'USB Speakers')
        monitor = Device('speaker_one.monitor', 'Monitor of USB Speakers', loopback=True)
        sc = soundcard(sink, [monitor])
        endpoint = select_endpoint(sc, 'linux', 'USB Speakers')
        self.assertIs(endpoint.device, monitor)
        self.assertIsNone(endpoint.follow_output_id)

    def test_linux_nonstandard_monitor_id_uses_public_matcher(self):
        sink = Device('custom_sink', 'Custom Speakers')
        monitor = Device('custom_monitor_source', 'Monitor of Custom Speakers', loopback=True)
        sc = soundcard(sink, [monitor])
        sc.get_microphone.return_value = monitor
        self.assertIs(select_endpoint(sc, 'linux').device, monitor)
        sc.get_microphone.assert_called_once_with(id='Custom Speakers', include_loopback=True)

    def test_linux_never_falls_back_to_microphone(self):
        sink = Device('sink', 'Speakers')
        mic = Device('mic', 'Speakers microphone')
        sc = soundcard(sink, [mic])
        sc.get_microphone.return_value = mic
        with self.assertRaisesRegex(AudioSetupError, 'not a sink monitor'):
            select_endpoint(sc, 'linux')
        with self.assertRaises(AudioSetupError):
            select_endpoint(sc, 'linux', 'mic')

    def test_macos_prefers_blackhole_2ch_without_default_output(self):
        mic = Device(1, 'MacBook Microphone', 1)
        blackhole = Device(23, 'BlackHole 2ch')
        larger = Device(24, 'BlackHole 16ch', 16)
        sc = soundcard(inputs=[mic, larger, blackhole])
        endpoint = select_endpoint(sc, 'darwin')
        self.assertIs(endpoint.device, blackhole)
        self.assertEqual(endpoint.info()['backend'], 'coreaudio-virtual-input')
        self.assertIsNone(endpoint.follow_output_id)
        sc.all_microphones.assert_called_once_with()
        sc.default_speaker.assert_not_called()

    def test_macos_missing_virtual_input_explains_setup(self):
        sc = soundcard(inputs=[Device(1, 'Built-in Microphone', 1)])
        with self.assertRaisesRegex(AudioSetupError, 'Multi-Output'):
            select_endpoint(sc, 'darwin')

    def test_macos_numeric_id_and_custom_virtual_name(self):
        custom = Device(104, 'Music Bus', 1)
        sc = soundcard(inputs=[Device(1, 'Built-in Microphone'), custom])
        endpoint = select_endpoint(sc, 'darwin', '104')
        self.assertIs(endpoint.device, custom)
        endpoint.recorder(44100, 441)
        custom.recorder.assert_called_once_with(samplerate=44100, channels=1, blocksize=441)

    def test_macos_multiple_virtual_inputs_require_choice(self):
        sc = soundcard(inputs=[Device(2, 'Soundflower (2ch)'), Device(3, 'Loopback Audio')])
        with self.assertRaisesRegex(AudioSetupError, 'Several'):
            select_endpoint(sc, 'darwin')

    def test_ambiguous_device_name_is_not_selected_arbitrarily(self):
        sc = soundcard(inputs=[Device(2, 'BlackHole 16ch'), Device(3, 'BlackHole 64ch')])
        with self.assertRaisesRegex(AudioSetupError, 'Ambiguous'):
            select_endpoint(sc, 'darwin', 'BlackHole')

    def test_device_list_marks_macos_virtual_inputs(self):
        sc = soundcard(inputs=[Device(1, 'Microphone'), Device(2, 'BlackHole 2ch')])
        rows = list_devices(sc, 'darwin')['devices']
        self.assertFalse(rows[0]['recommended'])
        self.assertTrue(rows[1]['recommended'])

    def test_unsupported_platform_fails_explicitly(self):
        with self.assertRaisesRegex(AudioSetupError, 'Unsupported'):
            select_endpoint(soundcard(), 'freebsd')


if __name__ == '__main__':
    unittest.main()
