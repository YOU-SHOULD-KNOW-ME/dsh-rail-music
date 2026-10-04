"""Platform-specific system-audio endpoint selection via SoundCard's public API.

Windows uses WASAPI loopback; Linux uses a PulseAudio sink monitor (including
PipeWire's PulseAudio server); macOS uses an explicitly routed virtual input.
No platform falls back to the default physical microphone.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class AudioSetupError(RuntimeError):
    """A capture endpoint cannot be selected without platform setup or config."""


class AudioDeviceNotFound(AudioSetupError):
    """No input matches an explicitly requested device."""


VIRTUAL_INPUT_NAMES = ('blackhole', 'soundflower', 'loopback audio', 'vb-cable', 'vb cable')


def backend_name(platform: str) -> str:
    names = {'win32': 'wasapi-loopback', 'linux': 'pulseaudio-monitor', 'darwin': 'coreaudio-virtual-input'}
    if platform not in names:
        raise AudioSetupError(f'Unsupported audio platform: {platform}')
    return names[platform]


def is_virtual_input(device: Any) -> bool:
    return any(name in str(device.name).casefold() for name in VIRTUAL_INPUT_NAMES)


def match_device(devices: list[Any], query: str) -> Any:
    """Prefer exact IDs, then exact names, then a unique name substring."""
    by_id = [device for device in devices if str(device.id) == str(query)]
    if len(by_id) == 1:
        return by_id[0]
    needle = str(query).casefold()
    exact = [device for device in devices if str(device.name).casefold() == needle]
    if len(exact) == 1:
        return exact[0]
    partial = exact or [device for device in devices if needle in str(device.name).casefold()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        raise AudioSetupError(f'Ambiguous audio device {query!r}; use an exact device ID from --list-devices')
    raise AudioDeviceNotFound(f'Audio device {query!r} not found; inspect --list-devices')


@dataclass
class CaptureEndpoint:
    device: Any
    platform: str
    follow_output_id: str | None = None

    def recorder(self, rate: int, hop: int):
        # WASAPI's one-channel capture has known SoundCard issues. Preserve the
        # existing two-channel Windows path; other backends honour input count.
        channels = 2 if self.platform == 'win32' else min(2, int(self.device.channels))
        if channels < 1:
            raise AudioSetupError('Selected input has no capture channels')
        return self.device.recorder(samplerate=rate, channels=channels, blocksize=hop)

    def info(self) -> dict[str, Any]:
        # Windows friendly-name property reads can crash some drivers. Default
        # selection and status reporting must not enumerate them unnecessarily.
        label = str(self.device.id) if self.platform == 'win32' else str(self.device.name)
        return {'platform': self.platform, 'backend': backend_name(self.platform),
                'deviceId': str(self.device.id), 'deviceName': label,
                'channels': 2 if self.platform == 'win32' else min(2, int(self.device.channels)),
                'followsDefaultOutput': self.follow_output_id is not None}

    def output_changed(self, sc: Any) -> bool:
        return self.follow_output_id is not None and str(sc.default_speaker().id) != self.follow_output_id


def select_endpoint(sc: Any, platform: str, device: str | None = None) -> CaptureEndpoint:
    backend_name(platform)
    if platform == 'darwin':
        # CoreAudio inputs are all isloopback=False in SoundCard. Do not request
        # include_loopback and do not choose the built-in microphone implicitly.
        inputs = list(sc.all_microphones())
        if device:
            selected = match_device(inputs, device)
        else:
            virtual = [item for item in inputs if is_virtual_input(item)]
            preferred = [item for item in virtual if str(item.name).casefold() == 'blackhole 2ch']
            if len(preferred) == 1:
                selected = preferred[0]
            elif len(virtual) == 1:
                selected = virtual[0]
            elif len(virtual) > 1:
                raise AudioSetupError('Several virtual audio inputs found; set config.device to the one receiving system audio')
            else:
                raise AudioSetupError('macOS needs a routed virtual audio input: install BlackHole 2ch, create a Multi-Output Device with your speakers/headphones + BlackHole, select it as sound output, and allow audio input access. See docs/PLATFORMS.md')
        return CaptureEndpoint(selected, platform)

    monitors = [item for item in sc.all_microphones(include_loopback=True) if item.isloopback]
    if device:
        # Accept a monitor/loopback name or ID. Linux additionally accepts a sink
        # ID/name and resolves its monitor, never a physical input.
        try:
            selected = match_device(monitors, device)
        except AudioDeviceNotFound:
            if platform != 'linux':
                raise
            sink = match_device(list(sc.all_speakers()), device)
            selected = linux_monitor(sc, monitors, sink)
        return CaptureEndpoint(selected, platform)

    speaker = sc.default_speaker()
    if speaker is None:
        raise AudioSetupError('No default audio output available')
    if platform == 'win32':
        selected = next((item for item in monitors if str(item.id) == str(speaker.id)), None)
        if selected is None:
            raise AudioSetupError('No WASAPI loopback for the default output')
    else:
        selected = linux_monitor(sc, monitors, speaker)
    return CaptureEndpoint(selected, platform, str(speaker.id))


def linux_monitor(sc: Any, monitors: list[Any], speaker: Any) -> Any:
    # PulseAudio/PipeWire sink IDs usually map to <sink>.monitor source IDs.
    for candidate in (f'{speaker.id}.monitor', str(speaker.id)):
        match = next((item for item in monitors if str(item.id) == candidate), None)
        if match is not None:
            return match
    # Public SoundCard matching handles descriptive monitor names on servers
    # with custom source IDs. Reject any physical microphone it might match.
    try:
        matched = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    except (IndexError, RuntimeError) as error:
        raise AudioSetupError('No monitor for default output; ensure PulseAudio or pipewire-pulse is running and set config.device to the sink monitor') from error
    if matched is None or not matched.isloopback:
        raise AudioSetupError('The matching input is not a sink monitor; set config.device to a monitor from --list-devices')
    return matched


def list_devices(sc: Any, platform: str) -> dict[str, Any]:
    backend = backend_name(platform)
    inputs = list(sc.all_microphones() if platform == 'darwin' else sc.all_microphones(include_loopback=True))
    if platform != 'darwin':
        inputs = [item for item in inputs if item.isloopback]
    return {'platform': platform, 'backend': backend, 'devices': [
        {'id': str(item.id), 'name': str(item.id) if platform == 'win32' else str(item.name),
         'channels': 2 if platform == 'win32' else int(item.channels),
         'recommended': is_virtual_input(item) if platform == 'darwin' else True}
        for item in inputs
    ]}
