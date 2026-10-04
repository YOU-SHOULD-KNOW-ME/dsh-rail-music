/**
 * dsh-rail-music — browser half
 * =============================
 *
 * Drives the DSH Turn-navigation rail (the tick ladder on the right edge of a
 * conversation) from the audio frames the Host plugin streams over
 * `GET /api/rail-music/events`.
 *
 * Registers a lazy DSH browser factory, with effects owning its listeners,
 * styles, animation and stream. A standalone harness can run the same file
 * without a module loader. No imports, bundler or React are required.
 *
 * Design constraints this file exists to honour
 * --------------------------------------------
 * 1. Position maps to frequency. Width carries energy and colour carries turn
 *    state; the active turn must remain the brightest and widest.
 * 2. Pointer and keyboard navigation immediately restore the native rail.
 * 3. No CSS transition on the audio bars: one envelope owns their smoothing.
 * 4. Silence sleeps: no signal for a moment and the loop drops to 4 Hz.
 * 5. Reduced motion is respected: the layer refuses to start unless forced.
 *
 * The rail is virtualized (@tanstack/react-virtual) and its marks are written
 * directly to the DOM outside React. This file never touches React state and
 * never re-renders anything — it writes a small set of CSS custom properties
 * on visible marks and scalar transforms on the compact level indicator.
 */
(() => {
  'use strict'

  function mount(CONFIG = {}) {
    const EVENTS_PATH = typeof CONFIG.eventsPath === 'string' && CONFIG.eventsPath !== ''
      ? CONFIG.eventsPath
      : '/api/rail-music/events'
    const VERSION = typeof CONFIG.version === 'string' ? CONFIG.version : '0.3.0'
    const lifetime = new AbortController()
    const STYLE_ID = 'dsh-rail-music-style'
    const STORAGE_KEY = 'dsh-rail-music:v2'
    let saved = {}
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {} } catch { /* storage optional */ }
    const THEMES = {
      rainbow: { label: '经典频谱', bass: 0, treble: 265, saturation: 85 },
      aurora: { label: '极光', bass: 160, treble: 265, saturation: 72 },
      ember: { label: '暖焰', bass: 20, treble: 55, saturation: 88 },
      mono: { label: '单色', bass: 210, treble: 210, saturation: 0 },
    }
    let THEME = Object.hasOwn(THEMES, saved.theme) ? saved.theme
      : Object.hasOwn(THEMES, CONFIG.theme) ? CONFIG.theme : 'rainbow'
    let PEAK_HOLD = saved.peakHold === true

    /**
     * Marker class that arms the override, toggled on `<html>`.
     *
     * This is the crux of the whole integration. The rail expresses its states
     * (rest 0.6, unloaded 0.4, preview 0.9, active 1.0) as one equally-specific
     * rule per state, so any override strong enough to drive the ticks from audio
     * is also strong enough to *permanently* erase those states. Scoping the
     * override behind this class means it only exists while the audio layer is
     * actually writing: the moment the pointer arrives or the music stops, the
     * class comes off and the rail's own stylesheet owns every tick again,
     * untouched. `<html>` is used rather than the nav because React re-renders
     * the nav's own className.
     */
    const ACTIVE_CLASS = 'dsh-rail-music'
    const ACTIVE_ROOT = document.documentElement

    /**
     * Marker class that widens the rail's frame, toggled on `<html>` for as long
     * as the audio layer is **enabled** (not merely writing).
     *
     * Widening the bars requires widening their container, and the container is
     * also the pointer's hit area. If that width were tied to the audio layer's
     * engage/disengage state, hovering would shrink the box under the pointer,
     * drop the pointer outside, widen it again, and oscillate — a flicker loop.
     * Keeping the geometry on a separate, hover-independent switch removes the
     * feedback path: the frame stays wide, only the bars revert on hover.
     */
    const WIDE_CLASS = 'dsh-rail-music-wide'

    /**
     * Tick width in music mode, and the frame width that contains it.
     *
     * The rail ships a 20px tick inside a 28px frame, which caps a bar at 28px
     * and leaves only 8px of travel between the narrowest and widest rest tick.
     * The frame is sized to the widest value the tick can reach (`TICK_MAX`), so
     * a saturated bar can never overflow the scroller into a horizontal
     * scrollbar. Bars grow leftwards: the frame is anchored at `right: 12px`.
     */
    let BAR_WIDTH = Number.isFinite(saved.barWidth ?? CONFIG.barWidth)
      ? Math.min(72, Math.max(16, saved.barWidth ?? CONFIG.barWidth))
      : 32
    let FRAME_WIDTH = Math.ceil(BAR_WIDTH * 1.4) + 1

    /** Legal range before the 20px tick outgrows its 28px frame. */
    const TICK_MIN = 0.35
    const TICK_MAX = 1.4

    /** Resting widths, mirroring TurnNavigator.module.css. */
    const BASE_REST = 0.6
    const BASE_UNLOADED = 0.4
    const BASE_PREVIEW = 0.9
    const BASE_ACTIVE = 1.0

    /**
     * How far audio may push a tick.
     *
     * Width now carries the **spectrum**: each tick reads the frequency content
     * at its own position on the ladder, so the ladder tracks the music instead
     * of just pulsing with its loudness. That costs the old guarantee that state
     * gaps survive at any volume — a loud bass tick can outgrow a quiet active
     * tick. Navigation moves to the channel that never moves: colour and
     * brightness (active is `label-primary`, unloaded is dimmed, hover is
     * `label-tertiary`), plus the one guarantee enforced in `paint()` — the
     * active tick is never narrower than any other tick in the same frame.
     */
    let AUDIO_DEPTH = Number.isFinite(saved.depth ?? CONFIG.depth)
      ? Math.min(0.95, Math.max(0, saved.depth ?? CONFIG.depth)) : 0.7

    /**
     * What drives a tick: mostly its own frequency band, plus overall loudness
     * and a kick on each detected onset. The weights deliberately sum above 1 so
     * a loud bass hit can saturate; an ordinary passage stays in the range where
     * neighbouring bands remain distinguishable.
     */
    const W_BAND = 0.62
    const W_LEVEL = 0.22
    const W_PULSE = 0.30

    /** Envelope follower, seconds. Fast in, slow out — the difference between
     *  "reacting to music" and "twitching". Kept short: this term is mixed into
     *  every tick, so a long release here reads as the whole ladder lagging. */
    const LEVEL_ATTACK = 0.012
    const LEVEL_RELEASE = 0.06
    const PULSE_DECAY = 0.07

    /**
     * Per-band envelope, seconds.
     *
     * Fast on both edges — this is what makes the ladder look like it is playing
     * *with* the music rather than following it. The global follower below stays
     * slow because it only drives the overall glow, where lag is invisible.
     */
    const BAND_ATTACK = 0.006
    const BAND_RELEASE = 0.03

    /**
     * Spectral tilt, calibrated at 24 bands and rescaled for other band counts.
     *
     * Music rolls off towards the top: measured on this machine the top bands sit
     * ~30 dB under the bass. Without compensation the upper half of the ladder is
     * permanently dead; with too much, the spectrum flattens into a rectangle.
     * This lifts the top while leaving the bass clearly the largest, which is the
     * shape every music player's analyser shows.
     */
    const BAND_TILT_DB = 1.3

    /**
     * Shared band window, dB.
     *
     * One window for every band, rather than one per band. Per-band gain control
     * (an earlier version of this file) makes each band fill its own range, which
     * *destroys the spectral shape* — the thing that makes bass read as bass.
     * The window's centre adapts to the material; its width does not.
     */
    const BAND_WINDOW_DB = 30
    const BAND_CENTER_TAU = 1.2

    /** Mild expansion so neighbouring bands separate instead of blurring. */
    const BAND_GAMMA = 1.15

    /** Adaptive gain for the global follower: how fast floor and ceiling chase. */
    const AGC_DECAY_DB_PER_S = 3.0
    const AGC_MIN_SPAN_DB = 20

    /**
     * Rainbow while the audio layer is engaged, by position on the ladder: bass
     * warm at the bottom, treble cool at the top. Brightness still carries the
     * turn state, so the current turn stays the brightest tick even in colour —
     * and the whole override is disarmed on hover, which is what returns the rail
     * to its own white/grey.
     */
    const LIGHT_REST = 52
    const LIGHT_ACTIVE = 66
    const LIGHT_UNLOADED = 34
    const SAT_REST = 85
    const SAT_UNLOADED = 55
    const LIGHT_FROM_ENERGY = 16

    /** Write suppression: skip sub-perceptual changes. */
    const WRITE_EPSILON = 0.004

    /**
     * Gain ramp time constants, in seconds. Asymmetric on purpose: the pointer
     * arriving clears audio immediately. Re-engaging uses a short ramp so the
     * ladder does not jump, without hiding the next musical transient.
     */
    const GAIN_RELEASE_IDLE_S = 0.25
    const GAIN_ATTACK_S = 0.025
    const GAIN_FLOOR = 0.003
    const IDLE_POLL_MS = 250

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

    const log = (...args) => console.info('%c[rail-music]', 'color:#3fb950', ...args)

    // ---------------------------------------------------------------- rail DOM

    /**
     * Find the Turn-navigation rail and the CSS-module class prefix its build
     * happened to generate. Nothing is hardcoded: the prefix is read back from a
     * live mark, so a rebuild that changes the hash keeps working, and the
     * Chinese and English builds are addressed identically (the nav's
     * `aria-label` is localized and therefore useless as an anchor).
     * @returns the rail parts, or null when the rail is not mounted.
     */
    function findRail() {
      for (const nav of document.querySelectorAll('nav')) {
        if (!/_frame/.test(nav.className || '')) continue
        const marks = nav.querySelector('[class*="_marks"]')
        const mark = marks && marks.firstElementChild
        if (!marks || !mark) continue
        let prefix = null
        for (const token of mark.classList) {
          const match = /^(.+)_mark$/.exec(token)
          if (match) { prefix = match[1]; break }
        }
        if (prefix === null) continue
        const slot = nav.closest('[class*="_slot"]')
        if (slot === null) continue
        return { nav, marks, slot, prefix, classes: collectClasses(prefix) }
      }
      return null
    }

    function collectClasses(prefix) {
      return {
        frame: `${prefix}_frame`,
        mark: `${prefix}_mark`,
        markUnloaded: `${prefix}_markUnloaded`,
        markActive: `${prefix}_markActive`,
        markPreview: `${prefix}_markPreview`,
        marks: `${prefix}_marks`,
        slot: `${prefix}_slot`,
      }
    }

    /**
     * Install the one stylesheet this feature needs.
     *
     * Armed only under `html.dsh-rail-music` (see ACTIVE_CLASS). While armed it
     * outranks every rail state rule, so the script is responsible for supplying
     * each state's resting width as a base and adding audio on top of it. The
     * transform transition is dropped on purpose: the envelope follower below is
     * the smoother, and a 140ms CSS transition on a value refreshed every 16ms
     * would double-smooth the signal into mush and lag the beat.
     * @param classes - generated class names for the current build.
     */
    function installStyle(classes) {
      document.getElementById(STYLE_ID)?.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-rail-music'
      style.textContent = `
  /* Geometry: present whenever music mode is enabled, independent of hover. */
  html.${WIDE_CLASS} .${classes.frame} {
    width: ${FRAME_WIDTH}px;
  }
  /* Audio override: present only while the audio layer is actually writing, so
     releasing it hands the rail back to its own white/grey, 20px look. */
  html.${ACTIVE_CLASS} .${classes.marks} .${classes.mark}::before {
    width: ${BAR_WIDTH}px;
    transform: translateY(-50%) scaleX(var(--rm-tick, ${BASE_REST}));
    background: hsl(var(--rm-hue, 210) var(--rm-sat, ${SAT_REST}%) var(--rm-light, ${LIGHT_REST}%));
    transition: none;
  }
  `
      document.head.append(style)
    }

    // ----------------------------------------------------------- audio signals

    /**
     * Adaptive, asymmetric envelope over the host's dBFS frames.
     *
     * Absolute level is useless on its own — a quiet acoustic track and a loud
     * master are both "music". The tracked floor and ceiling chase the signal
     * slowly, so each song is normalised against itself; the follower then makes
     * the response fast on the way up (the transient is the point) and slow on
     * the way down (so the ladder glides instead of strobing).
     */
    class Signal {
      constructor() {
        this.floorDb = -60
        this.ceilingDb = -12
        this.level = 0
        this.pulse = 0
        this.lastBeat = 0
        this.seenBeat = false
        /** Per-band normalised energy, index 0 = lowest frequency, envelope-applied. */
        this.bands = []
        /** Shared window centre in tilted dB; null until the first frame. */
        this.bandCenter = null
        this.peaks = []
        this.holds = []
      }

      /** @param frame - one host frame. @param dt - seconds since the previous frame. */
      push(frame, dt) {
        const db = frame.rms
        const decay = AGC_DECAY_DB_PER_S * dt
        // Floor rises, ceiling falls: both open outward instantly on a surprise.
        this.floorDb = Math.min(db, this.floorDb + decay)
        this.ceilingDb = Math.max(db, this.ceilingDb - decay)
        const span = Math.max(AGC_MIN_SPAN_DB, this.ceilingDb - this.floorDb)

        const target = clamp01((db - this.floorDb) / span)
        this.level += (target - this.level) * ramp(dt, target > this.level ? LEVEL_ATTACK : LEVEL_RELEASE)

        if (this.seenBeat && frame.beat > this.lastBeat) {
          this.lastBeat = frame.beat
          this.pulse = 1
        } else {
          this.pulse = Math.max(0, this.pulse - dt / PULSE_DECAY)
        }
        this.lastBeat = frame.beat
        this.seenBeat = true

        this.pushBands(frame.bands, dt)
      }

      /**
       * Normalise every band against **one shared window**, after lifting the top
       * of the spectrum.
       *
       * The tilt is what keeps the high bands alive; the shared window is what
       * keeps the *shape* — bass must still read as the biggest thing on the
       * ladder. The window's centre follows the material so a quiet track and a
       * loud master both fill the display, but its width is fixed, so relative
       * band sizes survive.
       * @param raw - band levels in dBFS from the host, lowest frequency first.
       * @param dt - seconds since the previous frame.
       */
      pushBands(raw, dt) {
        if (!Array.isArray(raw) || raw.length === 0) return
        if (this.bands.length !== raw.length) {
          this.bands = raw.map(() => 0)
          this.peaks = raw.map(() => 0)
          this.holds = raw.map(() => 0)
          this.bandCenter = null
        }
        let sum = 0
        for (let i = 0; i < raw.length; i++) sum += raw[i] + BAND_TILT_DB * 23 * i / Math.max(1, raw.length - 1)
        const mean = sum / raw.length
        if (this.bandCenter === null) this.bandCenter = mean
        else this.bandCenter += (mean - this.bandCenter) * ramp(dt, BAND_CENTER_TAU)

        const low = this.bandCenter - BAND_WINDOW_DB / 2
        for (let i = 0; i < raw.length; i++) {
          const tilted = raw[i] + BAND_TILT_DB * 23 * i / Math.max(1, raw.length - 1)
          const target = clamp01((tilted - low) / BAND_WINDOW_DB)
          const tau = target > this.bands[i] ? BAND_ATTACK : BAND_RELEASE
          this.bands[i] += (target - this.bands[i]) * ramp(dt, tau)
          if (this.bands[i] >= this.peaks[i]) {
            this.peaks[i] = this.bands[i]
            this.holds[i] = 0.15
          } else if (this.holds[i] > 0) this.holds[i] -= dt
          else this.peaks[i] = Math.max(this.bands[i], this.peaks[i] - dt * 2.5)
        }
      }

      /**
       * Band energy at a position on the ladder, interpolated so neighbouring
       * ticks differ smoothly instead of stepping through 14 discrete bands.
       * @param t - 0 at the top of the ladder, 1 at the bottom.
       * @returns normalised energy, 0..1.
       */
      bandAt(t) {
        const bands = PEAK_HOLD ? this.peaks : this.bands
        const count = bands.length
        if (count === 0) return 0
        if (count === 1) return bands[0]
        // Bass sits at the bottom of the ladder, treble at the top.
        const position = (1 - t) * (count - 1)
        const low = Math.floor(position)
        const high = Math.min(count - 1, low + 1)
        const frac = position - low
        return bands[low] * (1 - frac) + bands[high] * frac
      }
    }

    const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value)
    /** Exponential-ish approach rate for a time constant. */
    const ramp = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau))

    // ------------------------------------------------------------------ engine

    class RailMusic {
      constructor() {
        this.source = null
        this.rail = null
        this.enabled = false
        this.connected = false
        this.frame = null
        this.lastFrameAt = 0
        this.signal = new Signal()
        this.gain = 0
        this.cleared = true
        this.pointerInside = false
        this.lastTick = new WeakMap()
        this.timer = null
        this.lastFrameTime = 0
        this.mutation = null
        this.indicator = null
        this.timerKind = null
        this.forced = false
        this.receivedFrames = 0
        this.lastPaintAgeMs = null
        this.paintBuffers = null
      }

      // -- lifecycle ---------------------------------------------------------

      enable({ force = false } = {}) {
        if (this.enabled) return this.status()
        if (reduceMotion.matches && !force) {
          log('prefers-reduced-motion is set — refusing. Call enable({force:true}) to override.')
          return { ...this.status(), refused: 'reduced-motion' }
        }
        this.enabled = true
        this.forced = force
        this.signal = new Signal()
        this.frame = null
        this.gain = 0
        this.lastFrameTime = 0
        this.rail = findRail()
        if (this.rail !== null) this.attach()
        // Geometry is armed for the whole session, not per frame: see WIDE_CLASS.
        ACTIVE_ROOT.classList.add(WIDE_CLASS)
        this.connect()
        this.watchDom()
        this.showIndicator()
        this.tick(performance.now())
        this.save()
        log(`enabled (v${VERSION})`)
        return this.status()
      }

      disable({ keepControl = false, persist = true } = {}) {
        this.enabled = false
        this.cancelTick()
        this.source?.close()
        this.source = null
        this.mutation?.disconnect()
        this.mutation = null
        this.connected = false
        if (!keepControl) {
          this.stopIndicatorLayout()
          this.indicator?.root.remove()
          this.indicator = null
          document.getElementById('dsh-rail-music-controls-style')?.remove()
        }
        this.nav?.removeEventListener('pointerenter', this.onEnter)
        this.nav?.removeEventListener('pointerleave', this.onLeave)
        this.nav?.removeEventListener('focusin', this.onEnter)
        this.nav?.removeEventListener('focusout', this.onFocusOut)
        this.nav = null
        this.pointerInside = false
        this.gain = 0
        ACTIVE_ROOT.classList.remove(ACTIVE_CLASS)
        ACTIVE_ROOT.classList.remove(WIDE_CLASS)
        this.clearTicks()
        this.rail = null
        this.cleared = true
        document.getElementById(STYLE_ID)?.remove()
        if (persist) this.save()
        this.paintIndicator()
        log('disabled')
        return this.status()
      }

      toggle(options) {
        return this.enabled ? this.disable({ keepControl: true }) : this.enable(options)
      }

      save() {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: this.enabled,
            theme: THEME, depth: AUDIO_DEPTH, barWidth: BAR_WIDTH, peakHold: PEAK_HOLD }))
        } catch { /* private mode or quota: settings still work for this session */ }
      }

      cancelTick() {
        if (this.timerKind === 'raf') cancelAnimationFrame(this.timer)
        else if (this.timerKind === 'timeout') clearTimeout(this.timer)
        this.timer = null
        this.timerKind = null
      }

      wake() {
        if (!this.enabled || document.hidden) return
        if (this.timerKind === 'raf') return
        this.cancelTick()
        this.timerKind = 'raf'
        this.timer = requestAnimationFrame(now => this.tick(now))
      }

      /** Re-find the rail; the chat view can remount it on a session switch. */
      attach() {
        this.clearTicks()
        this.rail = findRail()
        if (this.rail === null) return false
        installStyle(this.rail.classes)
        this.lastTick = new WeakMap()
        if (this.nav !== this.rail.nav) {
          this.nav?.removeEventListener('pointerenter', this.onEnter)
          this.nav?.removeEventListener('pointerleave', this.onLeave)
          this.nav?.removeEventListener('focusin', this.onEnter)
          this.nav?.removeEventListener('focusout', this.onFocusOut)
          this.nav = this.rail.nav
          this.nav.addEventListener('pointerenter', this.onEnter)
          this.nav.addEventListener('pointerleave', this.onLeave)
          this.nav.addEventListener('focusin', this.onEnter)
          this.nav.addEventListener('focusout', this.onFocusOut)
          this.pointerInside = this.nav.matches(':hover') || this.nav.contains(document.activeElement)
        }
        return true
      }

      /** Re-emit the stylesheet after a geometry change. */
      restyle() {
        if (this.rail === null) this.rail = findRail()
        if (this.rail !== null) installStyle(this.rail.classes)
      }

      clearTicks() {
        if (this.rail === null) return
        for (const mark of this.rail.marks.children) {
          mark.style.removeProperty('--rm-tick')
          mark.style.removeProperty('--rm-hue')
          mark.style.removeProperty('--rm-sat')
          mark.style.removeProperty('--rm-light')
          // The write-suppression cache has to be invalidated with the properties.
          // Hue is positional and therefore constant, so a stale record makes the
          // re-engage write a no-op and every tick falls back to the stylesheet's
          // default colour — a uniform blue across the whole ladder.
          const record = this.lastTick.get(mark)
          if (record !== undefined) {
            record.tick = Number.NaN
            record.hue = Number.NaN
            record.sat = Number.NaN
            record.light = Number.NaN
          }
        }
      }

      watchDom() {
        this.mutation?.disconnect()
        this.mutation = new MutationObserver(() => {
          if (!this.enabled) return
          if (this.rail === null || !this.rail.nav.isConnected) this.attach()
        })
        this.mutation.observe(document.body, { childList: true, subtree: true })
      }

      // -- transport ---------------------------------------------------------

      connect() {
        this.source?.close()
        // Same origin as the page: no port, no CORS, and the existing session
        // cookie authenticates the route.
        const source = new EventSource(EVENTS_PATH)
        this.source = source
        source.onopen = () => {
          if (this.source !== source) return
          this.connected = true
          this.paintIndicator()
          log(`connected to ${EVENTS_PATH}`)
        }
        source.onmessage = (event) => {
          try {
            if (this.source !== source) return
            const frame = JSON.parse(event.data)
            if (!Number.isFinite(frame.rms) || !Number.isFinite(frame.beat)
              || !Array.isArray(frame.bands) || !frame.bands.every(Number.isFinite)) return
            this.frame = frame
            this.lastFrameAt = performance.now()
            this.receivedFrames += 1
            if (!frame.idle && !frame.stale) this.wake()
          } catch { /* keep the previous frame */ }
        }
        source.onerror = () => {
          if (this.source !== source) return
          if (this.connected) log(`stream ${EVENTS_PATH} interrupted — retrying`)
          this.connected = false
          this.paintIndicator()
        }
        source.addEventListener?.('shutdown', () => {
          if (this.source === source) api.dispose()
        })
      }

      // -- pointer -----------------------------------------------------------

      release() {
        this.gain = 0
        ACTIVE_ROOT.classList.remove(ACTIVE_CLASS)
        this.clearTicks()
        this.cleared = true
      }
      onEnter = () => { this.pointerInside = true; this.release() }
      onLeave = () => {
        this.pointerInside = this.nav?.contains(document.activeElement) ?? false
        this.wake()
      }
      onFocusOut = () => queueMicrotask(() => {
        this.pointerInside = this.nav?.matches(':hover') || this.nav?.contains(document.activeElement) || false
        this.wake()
      })

      // -- the loop ----------------------------------------------------------

      tick(now) {
        this.timer = null
        this.timerKind = null
        if (!this.enabled) return
        if (document.hidden) { this.release(); return }
        const dt = Math.min(0.1, (now - (this.lastFrameTime || now)) / 1000)
        this.lastFrameTime = now

        const frame = this.frame
        const fresh = frame !== null && now - this.lastFrameAt < 1000
        const idle = !fresh || frame.idle === true || frame.stale === true

        if (fresh && !idle) this.signal.push(frame, dt)

        // Gain ramps to zero on hover, on idle and on stream loss.
        const targetGain = idle || this.pointerInside ? 0 : 1
        const tau = targetGain === 1 ? GAIN_ATTACK_S : GAIN_RELEASE_IDLE_S
        this.gain += (targetGain - this.gain) * ramp(dt, tau)
        if (this.gain < GAIN_FLOOR) this.gain = 0

        if (this.rail === null || !this.rail.nav.isConnected) this.attach()

        if (this.rail !== null && this.gain > 0) {
          ACTIVE_ROOT.classList.add(ACTIVE_CLASS)
          this.paint()
          this.cleared = false
        } else if (!this.cleared) {
          // Hand the rail back to its own stylesheet: disarm the override so the
          // state rules apply again, and drop the inline values with it. Leaving
          // the last written value in place would pin every tick's width and kill
          // the native hover widening.
          ACTIVE_ROOT.classList.remove(ACTIVE_CLASS)
          if (this.rail !== null) this.clearTicks()
          this.cleared = true
        }

        this.paintIndicator()

        if (idle && this.gain === 0) {
          this.timerKind = 'timeout'
          this.timer = setTimeout(() => { this.tick(performance.now()) }, IDLE_POLL_MS)
        } else {
          this.timerKind = 'raf'
          this.timer = requestAnimationFrame(next => { this.tick(next) })
        }
      }

      paint() {
        const { marks, classes } = this.rail
        const children = marks.children
        const count = children.length
        if (count === 0) return
        const gain = this.gain
        const level = this.signal.level * gain
        const pulse = this.signal.pulse * gain

        // Two passes: the active tick's guarantee is relative to every other tick
        // in this same frame, so the values have to exist before any is written.
        if (this.paintBuffers?.values.length !== count) this.paintBuffers = {
          values: new Float64Array(count), energies: new Float64Array(count),
          actives: new Uint8Array(count), unloadeds: new Uint8Array(count),
        }
        const { values, energies, actives, unloadeds } = this.paintBuffers
        this.lastPaintAgeMs = Math.round(performance.now() - this.lastFrameAt)
        let activeCount = 0
        let widestOther = 0
        for (let i = 0; i < count; i++) {
          const mark = children[i]
          const active = mark.classList.contains(classes.markActive) || mark.matches(':focus-visible')
          const unloaded = mark.classList.contains(classes.markUnloaded)
          let base = BASE_REST
          if (unloaded) base = BASE_UNLOADED
          if (active) base = BASE_ACTIVE
          else if (mark.classList.contains(classes.markPreview)) base = BASE_PREVIEW

          const t = count === 1 ? 0.5 : i / (count - 1)
          // Gamma expands the gaps between neighbouring bands so the ladder reads
          // as distinct bars instead of one smooth blob.
          const band = Math.pow(this.signal.bandAt(t), BAND_GAMMA)
          const audio = Math.min(1, Math.max(0,
            W_BAND * band * gain + W_LEVEL * level + W_PULSE * pulse))
          const value = base + AUDIO_DEPTH * audio
          values[i] = value
          energies[i] = audio
          actives[i] = active ? 1 : 0
          unloadeds[i] = unloaded ? 1 : 0
          if (active) activeCount += 1
          else if (value > widestOther) widestOther = value
        }

        // Navigation guarantee: the turn you are on is never out-shouted by a
        // loud band elsewhere on the ladder.
        const floorForActive = activeCount > 0 ? Math.min(TICK_MAX, widestOther + 0.02) : 0

        for (let i = 0; i < count; i++) {
          const mark = children[i]
          let value = values[i]
          if (actives[i] === 1) value = Math.max(value, floorForActive)
          value = Math.min(TICK_MAX, Math.max(TICK_MIN, value))

          let record = this.lastTick.get(mark)
          if (record === undefined) {
            record = { tick: Number.NaN, hue: Number.NaN, sat: Number.NaN, light: Number.NaN }
            this.lastTick.set(mark, record)
          }

          if (!(Math.abs(record.tick - value) < WRITE_EPSILON)) {
            record.tick = value
            mark.style.setProperty('--rm-tick', value.toFixed(3))
          }

          // Colour: hue is positional, so it is written once per tick and then
          // left alone; only brightness follows the music.
          const t = count === 1 ? 0.5 : i / (count - 1)
          const theme = THEMES[THEME]
          const hue = Math.round(theme.treble + (theme.bass - theme.treble) * t)
          if (record.hue !== hue) {
            record.hue = hue
            mark.style.setProperty('--rm-hue', String(hue))
          }
          const sat = unloadeds[i] === 1 ? Math.min(SAT_UNLOADED, theme.saturation) : theme.saturation
          if (record.sat !== sat) {
            record.sat = sat
            mark.style.setProperty('--rm-sat', `${sat}%`)
          }
          const stateLight = actives[i] === 1 ? LIGHT_ACTIVE
            : unloadeds[i] === 1 ? LIGHT_UNLOADED : LIGHT_REST
          const darkLight = Math.round(actives[i] === 1 ? 76 + energies[i] * 6
            : Math.min(unloadeds[i] === 1 ? 44 : 64, stateLight + energies[i] * LIGHT_FROM_ENERGY))
          const light = document.body.hasAttribute('data-ds-dark-theme') ? darkLight : 100 - darkLight
          if (record.light !== light) {
            record.light = light
            mark.style.setProperty('--rm-light', `${light}%`)
          }
        }
      }

      // -- indicator ---------------------------------------------------------

      showIndicator() {
        if (this.indicator !== null) return
        const style = document.createElement('style')
        style.id = 'dsh-rail-music-controls-style'
        style.dataset.plugin = 'dsh-rail-music'
        style.textContent = `
  .rm-control { position:fixed; right:max(16px, env(safe-area-inset-right));
    --rm-safe-top:env(safe-area-inset-top, 0px); top:max(16px, var(--rm-safe-top)); z-index:20;
    color:var(--dsw-alias-label-primary, #e4e4e7); font:12px/1.5 system-ui, sans-serif; }
  .rm-actions { display:flex; align-items:center; gap:4px; padding:3px;
    border:1px solid var(--dsw-alias-border-l4, #444); border-radius:14px;
    background:var(--dsw-alias-bg-layer-1, #fff); color-scheme:light; }
  .rm-control button, .rm-control summary { box-sizing:border-box; cursor:pointer;
    display:flex; align-items:center; justify-content:center; width:32px; height:32px;
    background:transparent; color:inherit; border:0; border-radius:10px; padding:0; }
  .rm-control summary { list-style:none; font-size:17px; }
  .rm-control summary::-webkit-details-marker { display:none; }
  .rm-control :focus-visible { outline:2px solid var(--dsw-focus-ring-color, #76a9fa); outline-offset:2px; }
  .rm-control button:active { transform:scale(.97); }
  .rm-panel { position:absolute; right:0; top:calc(100% + 10px); width:240px;
    max-width:calc(100vw - 32px); max-height:var(--rm-panel-max-height, calc(100dvh - 100px)); overflow:auto;
    box-sizing:border-box; padding:16px; border-radius:16px;
    border:1px solid var(--dsw-alias-border-l4, #444);
    background:var(--dsw-alias-bg-layer-1, #fff); color-scheme:light;
    box-shadow:0 8px 28px #0003; }
  .rm-panel h2 { font-size:13px; margin:0 0 4px; font-weight:600; }
  .rm-panel p { margin:0 0 14px; opacity:.7; }
  .rm-panel label { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:12px 0 4px; }
  .rm-panel select { max-width:130px; padding:4px 6px; border-radius:6px; font:inherit; }
  .rm-panel input[type=range] { width:100%; accent-color:#7c9cff; }
  .rm-panel input[type=checkbox] { accent-color:#7c9cff; }
  .rm-bars { display:flex; align-items:flex-end; gap:2px; height:14px; pointer-events:none; }
  .rm-bars i { display:block; width:3px; height:14px; border-radius:2px;
    background:currentColor; transform-origin:center bottom; transform:scaleY(.22); }
  .rm-control button[aria-pressed=false] { opacity:.45; }
  body[data-ds-dark-theme] .rm-actions, body[data-ds-dark-theme] .rm-panel { color-scheme:dark; }
  @media (hover:hover) and (pointer:fine) {
    .rm-control button:hover, .rm-control summary:hover { background:#8882; }
  }
  @media (prefers-reduced-motion:reduce) { .rm-control button:active { transform:none; } }
  `
        document.head.append(style)
        const root = document.createElement('div')
        root.className = 'rm-control'
        const actions = document.createElement('div')
        actions.className = 'rm-actions'
        const dot = document.createElement('button')
        dot.type = 'button'
        dot.setAttribute('aria-keyshortcuts', 'Alt+M')
        const bars = document.createElement('span')
        bars.className = 'rm-bars'
        bars.setAttribute('aria-hidden', 'true')
        for (let i = 0; i < 3; i++) {
          const bar = document.createElement('i')
          bars.append(bar)
        }
        dot.append(bars)
        dot.addEventListener('click', () => { this.toggle() })
        const details = document.createElement('details')
        const summary = document.createElement('summary')
        summary.textContent = '⋯'
        summary.title = '律动设置'
        summary.setAttribute('aria-label', '律动设置')
        const panel = document.createElement('section')
        panel.className = 'rm-panel'
        panel.setAttribute('aria-label', '音乐律动设置')
        panel.innerHTML = `<h2>音乐律动</h2><p data-status></p>
  <label>配色 <select aria-label="配色"></select></label>
  <label>律动幅度 <output data-depth></output></label>
  <input type="range" aria-label="律动幅度" min="0" max="0.95" step="0.05">
  <label>条宽 <output data-width></output></label>
  <input type="range" aria-label="条宽" min="16" max="72" step="1">
  <label>峰值保持 <input type="checkbox" aria-label="峰值保持"></label>
  <p style="margin:12px 0 0">Alt + M 开关 · 悬停轨道恢复导航</p>`
        const select = panel.querySelector('select')
        for (const [value, theme] of Object.entries(THEMES)) {
          const option = document.createElement('option')
          option.value = value
          option.textContent = theme.label
          select.append(option)
        }
        select.value = THEME
        select.addEventListener('change', () => globalThis.__railMusic.setTheme(select.value))
        const [depth, width] = panel.querySelectorAll('input[type=range]')
        depth.value = String(AUDIO_DEPTH)
        width.value = String(BAR_WIDTH)
        const hold = panel.querySelector('input[type=checkbox]')
        hold.checked = PEAK_HOLD
        depth.addEventListener('input', () => globalThis.__railMusic.setDepth(depth.value))
        width.addEventListener('input', () => globalThis.__railMusic.setBarWidth(width.value))
        hold.addEventListener('change', () => globalThis.__railMusic.setPeakHold(hold.checked))
        details.append(summary, panel)
        actions.append(dot, details)
        root.append(actions)
        root.addEventListener('keydown', event => {
          if (event.key === 'Escape' && details.open) {
            details.open = false
            summary.focus()
          }
        })
        document.body.append(root)
        this.indicator = { root, dot, bars, details, panel, select, depth, width, hold }
        this.watchIndicatorLayout()
        this.syncControls()
        this.paintIndicator()
      }

      watchIndicatorLayout() {
        const control = this.indicator
        const anchors = 'header, [role="banner"], [role="toolbar"], [role="tablist"]'
        const queue = () => {
          if (this.indicator !== control || control.layoutFrame !== undefined) return
          control.layoutFrame = requestAnimationFrame(() => {
            delete control.layoutFrame
            if (this.indicator === control) this.positionIndicator(anchors)
          })
        }
        control.layoutAbort = new AbortController()
        control.layoutObserver = new ResizeObserver(queue)
        const observeAnchors = () => {
          control.layoutObserver.disconnect()
          control.layoutObserver.observe(control.root)
          for (const element of document.querySelectorAll(anchors)) {
            if (!control.root.contains(element)) control.layoutObserver.observe(element)
          }
        }
        control.layoutMutation = new MutationObserver(records => {
          const relevant = records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
            node.nodeType === 1 && !control.root.contains(node)
            && (node.matches(anchors) || node.querySelector(anchors))))
          if (relevant) { observeAnchors(); queue() }
        })
        control.layoutMutation.observe(document.body, { childList: true, subtree: true })
        addEventListener('resize', queue, { signal: control.layoutAbort.signal })
        addEventListener('scroll', queue, { capture: true, passive: true, signal: control.layoutAbort.signal })
        control.details.addEventListener('toggle', queue, { signal: control.layoutAbort.signal })
        observeAnchors()
        this.positionIndicator(anchors)
      }

      positionIndicator(anchors) {
        const control = this.indicator
        if (!control || !control.root.isConnected) return
        const box = control.root.getBoundingClientRect()
        // Keep clear of host headers without relying on generated CSS hashes.
        const baseTop = Math.max(16, parseFloat(getComputedStyle(control.root).getPropertyValue('--rm-safe-top')) || 0)
        let top = baseTop
        const occupied = [...document.querySelectorAll(anchors)]
          .filter(element => !control.root.contains(element))
          .map(element => element.getBoundingClientRect())
          .filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0
            && rect.top < Math.min(200, innerHeight / 2)
            && rect.left < box.right + 8 && rect.right > box.left - 8)
          .sort((a, b) => a.top - b.top)
        for (const rect of occupied) {
          if (top < rect.bottom + 8 && top + box.height > rect.top - 8) top = rect.bottom + 8
        }
        top = Math.min(top, Math.max(16, innerHeight - box.height - 16))
        const nextTop = `${Math.ceil(top)}px`
        if (control.root.style.top !== nextTop) control.root.style.top = nextTop
        control.panel.style.setProperty('--rm-panel-max-height', `${Math.max(0, innerHeight - top - box.height - 26)}px`)
      }

      stopIndicatorLayout() {
        const control = this.indicator
        if (!control) return
        control.layoutAbort?.abort()
        control.layoutObserver?.disconnect()
        control.layoutMutation?.disconnect()
        if (control.layoutFrame !== undefined) cancelAnimationFrame(control.layoutFrame)
      }

      syncControls() {
        if (this.indicator === null) return
        const { panel, select, depth, width, hold } = this.indicator
        select.value = THEME
        depth.value = String(AUDIO_DEPTH)
        width.value = String(BAR_WIDTH)
        hold.checked = PEAK_HOLD
        panel.querySelector('[data-depth]').textContent = `${Math.round(AUDIO_DEPTH * 100)}%`
        panel.querySelector('[data-width]').textContent = `${BAR_WIDTH}px`
      }

      paintIndicator() {
        if (this.indicator === null) return
        const state = !this.enabled ? reduceMotion.matches ? '已暂停 · 减少动态效果' : '已暂停'
          : !this.connected ? '正在连接音频…'
          : !this.frame || performance.now() - this.lastFrameAt >= 1000 ? '等待音频数据'
          : this.frame.idle ? '等待音乐' : '音乐模式已开启'
        if (this.indicator.state !== state) {
          this.indicator.state = state
          this.indicator.dot.title = `${state} · Alt+M 开关`
          this.indicator.dot.setAttribute('aria-label', this.enabled ? '暂停音乐律动' : '开启音乐律动')
          this.indicator.dot.setAttribute('aria-pressed', String(this.enabled))
          this.indicator.panel.querySelector('[data-status]').textContent = state
        }
        const { bands, level, pulse } = this.signal
        // Three bars, bass to treble, taken from the same normalised bands the
        // ladder reads so the dot and the rail never disagree.
        const last = Math.max(0, bands.length - 1)
        const picks = bands.length === 0
          ? [level, level, level]
          : [bands[0], bands[Math.floor(last / 2)], bands[last]]
        for (let i = 0; i < 3; i++) {
          const value = Math.max((picks[i] ?? 0) * this.gain, (level + pulse) * this.gain * 0.5)
          const transform = `scaleY(${(0.22 + clamp01(value) * 0.78).toFixed(3)})`
          const bar = this.indicator.bars.children[i]
          if (bar.style.transform !== transform) bar.style.transform = transform
        }
      }

      // -- introspection -----------------------------------------------------

      status() {
        return {
          version: VERSION,
          eventsPath: EVENTS_PATH,
          enabled: this.enabled,
          connected: this.connected,
          railFound: this.rail !== null,
          marks: this.rail === null ? 0 : this.rail.marks.children.length,
          gain: Number(this.gain.toFixed(3)),
          depth: AUDIO_DEPTH,
          barWidth: BAR_WIDTH,
          frameWidth: FRAME_WIDTH,
          level: Number(this.signal.level.toFixed(3)),
          pulse: Number(this.signal.pulse.toFixed(3)),
          beats: this.signal.lastBeat,
          rms: this.frame?.rms ?? null,
          idle: this.frame?.idle ?? null,
          prefersReducedMotion: reduceMotion.matches,
          theme: THEME,
          peakHold: PEAK_HOLD,
          profile: CONFIG.profile ?? 'balanced',
          receivedFrames: this.receivedFrames,
          receiveToPaintMs: this.lastPaintAgeMs,
          frameAgeMs: this.lastFrameAt ? Math.round(performance.now() - this.lastFrameAt) : null,
        }
      }
    }

    // -------------------------------------------------------------- install

    const existing = globalThis.__railMusic
    if (existing !== undefined) {
      log(`already loaded (v${existing.status().version}); leaving it in place`)
      return existing
    }

    const engine = new RailMusic()
    const api = globalThis.__railMusic = {
      enable: options => engine.enable(options),
      disable: () => engine.disable(),
      toggle: options => engine.toggle(options),
      status: () => engine.status(),
      /** Escape hatch for reduced-motion users who want it anyway. */
      force: () => engine.enable({ force: true }),
      /**
       * How hard the music drives the ladder, 0..0.95. Above ~0.8 a saturated
       * rest tick starts approaching the width ceiling, so the headroom that
       * keeps the active turn findable shrinks with it.
       * @param value - new additive depth.
       */
      setDepth: (value) => {
        const next = Number(value)
        if (Number.isFinite(next)) AUDIO_DEPTH = Math.min(0.95, Math.max(0, next))
        engine.save()
        engine.syncControls()
        return engine.status()
      },
      /**
       * Bar width in music mode, 16..72 px. The frame is resized with it so a
       * saturated bar can never overflow into a horizontal scrollbar. 20 is what
       * the rail ships; 32 is roughly where the spectrum becomes readable.
       * @param value - new width in pixels.
       */
      setBarWidth: (value) => {
        const next = Number(value)
        if (Number.isFinite(next)) {
          BAR_WIDTH = Math.min(72, Math.max(16, next))
          FRAME_WIDTH = Math.ceil(BAR_WIDTH * 1.4) + 1
          engine.restyle()
        }
        engine.save()
        engine.syncControls()
        return engine.status()
      },
      setTheme: value => {
        if (Object.hasOwn(THEMES, value)) THEME = value
        engine.save()
        engine.syncControls()
        engine.wake()
        return engine.status()
      },
      setPeakHold: value => {
        PEAK_HOLD = Boolean(value)
        engine.save()
        engine.syncControls()
        return engine.status()
      },
      dispose: () => {
        if (lifetime.signal.aborted) return
        lifetime.abort()
        // Package disable must not overwrite the user's Music Mode preference.
        engine.disable({ persist: false })
        if (globalThis.__railMusic === api) delete globalThis.__railMusic
      },
      engine,
    }

    addEventListener('keydown', (event) => {
      if (!event.repeat && !event.isComposing && event.altKey && !event.ctrlKey && !event.metaKey
        && (event.key === 'm' || event.key === 'M')) {
        event.preventDefault()
        engine.toggle()
      }
    }, { capture: true, signal: lifetime.signal })

    document.addEventListener('visibilitychange', () => {
      if (!engine.enabled) return
      engine.cancelTick()
      if (document.hidden) {
        engine.source?.close()
        engine.source = null
        engine.connected = false
        engine.release()
      } else {
        engine.frame = null
        engine.lastFrameTime = 0
        engine.connect()
        engine.wake()
      }
    }, { signal: lifetime.signal })
    reduceMotion.addEventListener('change', () => {
      if (reduceMotion.matches && engine.enabled && !engine.forced) engine.disable({ keepControl: true })
    }, { signal: lifetime.signal })

    log(`loaded v${VERSION} from ${EVENTS_PATH}. Alt+M toggles.`)
    if (saved.enabled !== false && !reduceMotion.matches) engine.enable({ force: false })
    else engine.showIndicator()
    return api
  }

  // The /api script route remains compatible with pages served by 0.2.0.
  // Native DSH serves the factory through /plugins and owns its effect.
  const legacyScript = document.currentScript?.src
    && new URL(document.currentScript.src).pathname === '/api/rail-music/client.js'
  if (globalThis.__ModuleLoader__?.load && !legacyScript) {
    globalThis.__ModuleLoader__.load({
      id: 'dsh-rail-music',
      factory: () => ({
        name: 'rail-music-client',
        apply(ctx) {
          ctx.effect(() => {
            const lifetime = new AbortController()
            let mounted = null
            // A live enable has no new HTML injection. Fetch only lightweight
            // config, never wait for Python or the first sound frame.
            void fetch('/api/rail-music/status', { signal: lifetime.signal, cache: 'no-store' })
              .then(response => {
                if (!response.ok) throw new Error(`rail-music status: HTTP ${response.status}`)
                return response.json()
              })
              .then(status => {
                if (!lifetime.signal.aborted) mounted = mount(status.client ?? globalThis.__DSH_RAIL_MUSIC__ ?? {})
              })
              .catch(error => {
                if (lifetime.signal.aborted) return
                console.warn('[rail-music] cannot read host defaults:', error)
                mounted = mount(globalThis.__DSH_RAIL_MUSIC__ ?? {})
              })
            return () => { lifetime.abort(); mounted?.dispose() }
          }, 'rail-music: browser resources')
        },
      }),
    })
  } else mount(globalThis.__DSH_RAIL_MUSIC__ ?? {})
})()
