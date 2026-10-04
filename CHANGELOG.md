# Changelog

## 0.3.1 — 2026-10-04

- Remove hardcoded local DSH checkout paths from the browser tests and developer tools. They now require an explicit `DSH_CHECKOUT` and exit with a clear message when it is unset.
- No plugin runtime code changed; `lib/` is identical to 0.3.0.

## 0.3.0 — 2026-10-04

- Add a platform audio adapter: Windows WASAPI loopback, Linux PulseAudio/PipeWire sink monitors, and macOS routed virtual inputs such as BlackHole 2ch.
- Resolve Linux sink IDs separately from monitor IDs. Follow default sink changes; accept explicit monitor/sink names or IDs.
- Select virtual macOS inputs without requiring SoundCard's unsupported CoreAudio loopback flag. Explain missing routing setup and avoid default microphone fallback.
- Honour one/two-channel capture on non-Windows platforms, reject ambiguous names, add `--list-devices`, and report actual capture backend/device in Host status.
- Add 12 routing regression cases, a Windows/Linux/macOS CI matrix, a Linux null-sink capture job and platform setup documentation. Windows live capture verified; Linux/macOS physical-device validation remains pending.

## 0.2.1 — 2026-10-02

- Move music controls to the upper right, with downward-opening settings. Avoid native headers, toolbars and dock tabs, reposition on layout changes, and keep native popup layers above the control.

- Declare a native `dsh.client` browser module and `./client` export. DSH now owns activation and teardown when the Plugins switch changes.
- Remove the default 1.5 second capture startup delay. Python initialization remains asynchronous; the control does not wait for an audio frame.
- Send an SSE shutdown event and close existing streams during Host disposal. Restore the rail without waiting for the stale-frame timeout.
- Remove keyboard/media/visibility listeners, styles, timers and controls on native unload. Preserve the user's Music Mode preference when the package is disabled.
- Prevent an aborted configuration request from creating controls after unload. Fetch current defaults on live activation, including pages initially served with the package disabled.
- Add 15-cycle browser lifecycle regression coverage, Windows CI checks, Python requirements and an allowlisted source ZIP command.

## 0.2.0 — 2026-10-02

- Wake rendering on live audio frames; add balanced and responsive FFT profiles.
- Add four themes, optional peak hold, persistent controls and settings.
- Preserve anti-phase stereo energy and avoid default-device friendly-name enumeration.
- Add bounded SSE backpressure and DSP, Host and browser regression checks.

## 0.1.0

- Initial WASAPI loopback capture and spectrum-driven turn-navigation rail.
