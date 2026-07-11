#!/usr/bin/env python3
"""Procedural placeholder-music generator for IMPERIUM: Twilight of Empires.

Renders three seamlessly looping stereo music beds entirely from numpy DSP
(no third-party audio, no samples -- 100% original procedural work). They
stand in for licensed period recordings (Byzantine chant / oud / war drums)
until real music is licensed.

    audio/music/menu_theme.ogg       (~90 s loop)  contemplative Byzantine menu
    audio/music/campaign_ambient.ogg (~110 s loop) sparse in-game background
    audio/music/battle_drums.ogg     (~81 s loop)  martial war-drum overlay

Recipes
-------
menu_theme : a dark sustained drone on D (D2 root + A2 fifth + faint D3
    octave), each pitch a stack of detuned sine/triangle oscillators with
    independent very-slow amplitude LFOs; above it a single chant-like voice
    (harmonics + fake "ah" formant, slow vibrato) sings four sparse phrases
    in D dorian coloured with a lowered 2nd (Eb), several notes ornamented
    with slow 1-2 semitone onset slides; a distant, low-passed additive
    bell (classic hum/prime/tierce partials) strikes every 22-23 s.

campaign_ambient : the same drone bed at a lower level, an oud-like
    plucked voice built from Karplus-Strong strings (slightly detuned
    double course, 15 ms strum gap, warm low-pass) playing four short
    improvisatory D-dorian phrases separated by long stretches of drone
    only, and three very soft frame-drum thumps. Deliberately sparse and
    low so it sits behind game SFX.

battle_drums : a war-drum ensemble at 95 BPM, 32 bars per loop. Deep
    taiko-like hits (exponential 82->50 Hz pitch-dropping sine + skin
    noise + stick click) play a dotted-eighth martial pattern, a second
    higher drum doubles beats 1 and 3 slightly left, band-passed rim/stick
    clicks tick on the right, and in the last 4 bars of each 16-bar half
    a double-time low-drum layer crescendos in. Underneath sits a tense
    low drone (D1 + a beating D2/Eb2 minor-second pair). No melody.

Looping : every track is rendered fade_s seconds long, then the tail past
the loop point is equal-power crossfaded into the head and the file is cut
exactly at the loop length -- sample loop_n-1 flows into sample 0 with no
click and no fade-to-silence.

Loudness : two-pass ffmpeg loudnorm (I=-16 LUFS, TP=-1.5 dB, LRA=11) with
linear=true on the second pass so a constant gain is applied and the loop
seam is preserved; all three tracks therefore match in level.

Deterministic: fixed RNG seed per track (period years 1453/1402/1444).
Output: 44100 Hz stereo, peak-normalized to -1 dBFS before loudnorm,
audio starts at sample zero, encoded to OGG Vorbis (-q:a 4) with the
ffmpeg binary shipped in the imageio-ffmpeg wheel.

Run standalone:  python3 audio/tools/gen_music.py
"""

import json
import math
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MUSIC_DIR = os.path.join(REPO_ROOT, "audio", "music")

FFMPEG_FALLBACK = (
    "/root/.local/lib/python3.11/site-packages/imageio_ffmpeg/binaries/"
    "ffmpeg-linux-x86_64-v7.0.2"
)

SIZE_BUDGET = 5 * 1024 * 1024  # 5 MB per file


def get_ffmpeg():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return FFMPEG_FALLBACK


# ----------------------------------------------------------------------------
# DSP primitives (pure numpy; scipy is not installed, so filtering is done in
# the FFT domain with Butterworth-style magnitude responses)
# ----------------------------------------------------------------------------

def fft_lowpass(x, fc, order=2):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1.0 / SR)
    H = 1.0 / np.sqrt(1.0 + (f / fc) ** (2 * order))
    return np.fft.irfft(X * H, n=len(x))


def fft_bandpass(x, f_lo, f_hi, order=2):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1.0 / SR)
    with np.errstate(divide="ignore"):
        hp = 1.0 / np.sqrt(1.0 + (f_lo / np.maximum(f, 1e-9)) ** (2 * order))
    lp = 1.0 / np.sqrt(1.0 + (f / f_hi) ** (2 * order))
    return np.fft.irfft(X * hp * lp, n=len(x))


def exp_env(n, t60):
    t = np.arange(n) / SR
    return np.exp(-6.9078 * t / t60)


def raised_cos_attack(n_total, attack_s):
    env = np.ones(n_total)
    na = max(1, min(n_total, int(attack_s * SR)))
    env[:na] = 0.5 - 0.5 * np.cos(np.pi * np.arange(na) / na)
    return env


def midi_to_freq(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def normalize(x, peak_db=-1.0):
    peak = np.max(np.abs(x))
    if peak > 0:
        x = x * (10.0 ** (peak_db / 20.0) / peak)
    return x


def add_pan(dst, src, start_s, pan=0.0, gain=1.0):
    """Mix mono `src` into stereo buffer `dst` at start_s with equal-power pan
    (pan -1 = hard left .. +1 = hard right). Truncates at the buffer end."""
    i = max(0, int(round(start_s * SR)))
    j = min(dst.shape[0], i + len(src))
    if j <= i:
        return
    seg = src[: j - i] * gain
    th = (pan + 1.0) * math.pi / 4.0
    dst[i:j, 0] += seg * math.cos(th)
    dst[i:j, 1] += seg * math.sin(th)


def stereo_echo(mono, n_total, gains=(0.22, 0.18), delays=(0.181, 0.263),
                lp=1600.0, dry=0.92):
    """Center dry signal + one low-passed echo per channel -> (n,2)."""
    st = np.zeros((n_total, 2))
    m = mono[:n_total]
    st[: len(m), 0] += dry * m
    st[: len(m), 1] += dry * m
    wet = fft_lowpass(m, lp)
    for ch, (g, d) in enumerate(zip(gains, delays)):
        di = int(d * SR)
        j = min(n_total, di + len(wet))
        st[di:j, ch] += g * wet[: j - di]
    return st


def crossfade_loop(x, loop_n, fade_n):
    """Equal-power crossfade of the tail [loop_n, loop_n+fade_n) into the
    head [0, fade_n), then cut at loop_n. Sample loop_n-1 wraps to sample 0
    (which equals original sample loop_n) with perfect continuity."""
    assert x.shape[0] >= loop_n + fade_n, "render too short for loop fade"
    out = x[:loop_n].copy()
    t = (np.arange(fade_n) / fade_n)[:, None]
    g_in = np.sin(0.5 * np.pi * t)
    g_out = np.cos(0.5 * np.pi * t)
    out[:fade_n] = x[:fade_n] * g_in + x[loop_n : loop_n + fade_n] * g_out
    return out


# ----------------------------------------------------------------------------
# Shared instruments
# ----------------------------------------------------------------------------

def drone_bed(freq_levels, n, rng, variants_cents=(-5.0, 0.0, 4.0),
              variant_pans=(-0.45, 0.05, 0.45), tri_mix=0.4, lfo_depth=0.35):
    """Layered detuned sine/triangle drone -> (n,2).

    freq_levels: list of (freq_hz, level). Each pitch gets one detuned
    oscillator per entry of variants_cents, each with its own very slow
    amplitude LFO (0.02-0.06 Hz) and pan position, plus a global slow swell.
    """
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    swell = 1.0 + 0.15 * np.sin(2 * np.pi * 0.011 * t + rng.uniform(0, 2 * math.pi))
    for f0, level in freq_levels:
        for cents, pan in zip(variants_cents, variant_pans):
            f = f0 * 2.0 ** (cents / 1200.0)
            ph = 2 * np.pi * f * t + rng.uniform(0, 2 * math.pi)
            s = np.sin(ph)
            tri = (2.0 / np.pi) * np.arcsin(np.sin(ph * 1.0))
            wav = (1.0 - tri_mix) * s + tri_mix * tri
            lfo_f = rng.uniform(0.02, 0.06)
            lfo = 1.0 + lfo_depth * np.sin(
                2 * np.pi * lfo_f * t + rng.uniform(0, 2 * math.pi))
            seg = level * wav * lfo
            th = (pan + 1.0) * math.pi / 4.0
            out[:, 0] += seg * math.cos(th)
            out[:, 1] += seg * math.sin(th)
    out *= swell[:, None] / max(len(freq_levels), 1)
    return out


BELL_PARTIALS = [
    # (ratio, amp, t60_s, beat_hz) -- classic bell spectrum, long distant decay
    (0.50, 0.55, 8.0, 0.9),
    (1.00, 1.00, 7.0, 1.4),
    (1.20, 0.60, 5.0, 0.0),
    (1.50, 0.45, 4.0, 0.0),
    (2.00, 0.50, 3.0, 0.0),
    (2.67, 0.25, 1.5, 0.0),
    (3.01, 0.18, 0.9, 0.0),
]


def bell_strike(f0, dur, rng):
    """Distant additive bell (mono), low-passed for distance."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    bell = np.zeros(n)
    for ratio, amp, t60, beat in BELL_PARTIALS:
        f = f0 * ratio
        env = exp_env(n, t60)
        if beat > 0.0:
            a = np.sin(2 * np.pi * (f - beat / 2) * t + rng.uniform(0, 2 * math.pi))
            b = np.sin(2 * np.pi * (f + beat / 2) * t + rng.uniform(0, 2 * math.pi))
            bell += amp * env * 0.5 * (a + b)
        else:
            bell += amp * env * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * math.pi))
    bell *= raised_cos_attack(n, 0.004)
    bell = fft_lowpass(bell, 2500.0)
    return bell / max(np.max(np.abs(bell)), 1e-12)


def chant_note(midi, dur, slide_semi, slide_t, rng, release=1.1):
    """One chant-voice note (mono). slide_semi != 0 starts the pitch that many
    semitones away from the target and glides in over slide_t seconds."""
    n = int((dur + release) * SR)
    t = np.arange(n) / SR
    f_tgt = midi_to_freq(midi)
    if slide_semi != 0.0 and slide_t > 0.0:
        s = np.clip(t / slide_t, 0.0, 1.0)
        s = s * s * (3.0 - 2.0 * s)  # smoothstep glide
        f = f_tgt * 2.0 ** (slide_semi / 12.0) * (2.0 ** (-slide_semi / 12.0)) ** s
    else:
        f = np.full(n, f_tgt)
    # slow vibrato fading in after ~0.6 s
    vib_gate = np.clip((t - 0.6) / 0.8, 0.0, 1.0)
    f = f * (1.0 + 0.003 * vib_gate * np.sin(2 * np.pi * 4.2 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR

    note = np.zeros(n)
    for h, a in ((1, 1.0), (2, 0.32), (3, 0.18), (4, 0.09), (5, 0.05)):
        note += a * np.sin(h * ph + rng.uniform(0, 2 * math.pi))
    # dark voice: low-pass body + faint "ah" formant band
    note = 0.75 * fft_lowpass(note, 1900.0) + 0.25 * fft_bandpass(note, 500.0, 1100.0)
    # faint breathiness
    breath = fft_bandpass(rng.standard_normal(n), 800.0, 2200.0)
    note += 0.015 * breath / max(np.max(np.abs(breath)), 1e-12)

    env = raised_cos_attack(n, min(0.6, dur * 0.3))
    nr = int(release * SR)
    env[-nr:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(nr) / nr)
    env *= 1.0 + 0.06 * np.sin(2 * np.pi * 0.13 * t + rng.uniform(0, 2 * math.pi))
    return note * env


def ks_pluck(f0, dur, rng, t60=None, burst_lp=4000.0):
    """Karplus-Strong plucked string (mono), block-vectorized."""
    N = max(2, int(round(SR / f0)))
    n = int(dur * SR)
    if t60 is None:
        t60 = dur * 0.85
    damp = math.exp(-6.9078 / max(f0 * t60, 1e-6))
    buf = rng.uniform(-1.0, 1.0, N)
    buf = fft_lowpass(buf, burst_lp)
    out = np.empty(n + N)
    pos = 0
    while pos < n:
        out[pos : pos + N] = buf
        buf = damp * 0.5 * (buf + np.roll(buf, -1))
        pos += N
    out = out[:n]
    out *= raised_cos_attack(n, 0.002)
    out[-int(0.05 * SR):] *= np.linspace(1.0, 0.0, int(0.05 * SR))
    return out


def oud_note(midi, dur, rng, vel=1.0):
    """Oud-like double course: two KS strings detuned ~13 cents apart, the
    second strummed 15 ms late, warm low-pass on the pair -> mono."""
    f0 = midi_to_freq(midi)
    a = ks_pluck(f0 * 2.0 ** (-6.0 / 1200.0), dur, rng)
    b = ks_pluck(f0 * 2.0 ** (7.0 / 1200.0), dur, rng)
    gap = int(0.015 * SR)
    note = np.zeros(len(a) + gap)
    note[: len(a)] += a
    note[gap : gap + len(b)] += 0.75 * b
    note = fft_lowpass(note, 2600.0)
    return vel * note / max(np.max(np.abs(note)), 1e-12)


def frame_drum(rng, vel=1.0):
    """Soft frame-drum thump (mono)."""
    n = int(0.6 * SR)
    t = np.arange(n) / SR
    f = 58.0 + (95.0 - 58.0) * np.exp(-t / 0.045)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * exp_env(n, 0.30)
    skin = fft_lowpass(rng.standard_normal(n), 420.0) * exp_env(n, 0.05)
    x = body + 0.30 * skin / max(np.max(np.abs(skin)), 1e-12)
    x *= raised_cos_attack(n, 0.004)
    return vel * x / max(np.max(np.abs(x)), 1e-12)


def taiko_hit(rng, vel=1.0, f_hi=82.0, f_lo=50.0, dur=0.9, t60=0.5):
    """Deep taiko-like hit: pitch-dropping sine + skin noise + stick click."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f_lo + (f_hi - f_lo) * np.exp(-t / 0.055)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * exp_env(n, t60)
    body += 0.28 * np.sin(2 * ph) * exp_env(n, t60 * 0.4)
    skin = fft_bandpass(rng.standard_normal(n), 150.0, 1200.0) * exp_env(n, 0.07)
    click = fft_bandpass(rng.standard_normal(n), 1500.0, 4000.0) * exp_env(n, 0.012)
    x = (body
         + 0.35 * skin / max(np.max(np.abs(skin)), 1e-12)
         + 0.12 * click / max(np.max(np.abs(click)), 1e-12))
    x *= raised_cos_attack(n, 0.0015)
    return vel * x / max(np.max(np.abs(x)), 1e-12)


def rim_click(rng, vel=1.0):
    """Short band-passed stick/rim click (mono)."""
    n = int(0.06 * SR)
    x = fft_bandpass(rng.standard_normal(n), 2200.0, 5200.0) * exp_env(n, 0.030)
    t = np.arange(n) / SR
    x += 0.4 * np.sin(2 * np.pi * 3800.0 * t) * exp_env(n, 0.012)
    x *= raised_cos_attack(n, 0.001)
    return vel * x / max(np.max(np.abs(x)), 1e-12)


# ----------------------------------------------------------------------------
# 1) menu_theme.ogg  (~90 s loop) -- contemplative Byzantine menu music
# ----------------------------------------------------------------------------

MENU_LOOP_S = 90.0
MENU_FADE_S = 2.0

# D dorian with occasional lowered 2nd (Eb4=63) for the Byzantine colour.
# (start_s, dur_s, midi, slide_semitones, slide_time_s)
MENU_MELODY = [
    # phrase 1 -- statement around the final (D)
    (6.0, 4.0, 62, 0.0, 0.0),      # D4
    (10.5, 3.0, 65, -2.0, 0.5),    # F4, slid up from Eb
    (14.0, 3.0, 64, 0.0, 0.0),     # E4
    (17.5, 4.5, 62, 1.0, 0.6),     # D4, slid down from Eb (lowered 2nd)
    # phrase 2 -- answer touching the lowered 2nd directly
    (27.0, 3.5, 67, 0.0, 0.0),     # G4
    (31.0, 3.0, 65, 2.0, 0.5),     # F4, slid down from G
    (34.5, 2.5, 63, 0.0, 0.0),     # Eb4 (lowered 2nd)
    (37.5, 4.5, 62, 0.0, 0.0),     # D4
    # phrase 3 -- rise to the dominant and descend
    (48.0, 3.0, 69, -2.0, 0.6),    # A4, slid up from G
    (51.5, 2.5, 67, 0.0, 0.0),     # G4
    (54.5, 3.0, 65, 0.0, 0.0),     # F4
    (58.0, 2.5, 64, 0.0, 0.0),     # E4
    (61.0, 4.0, 62, 1.0, 0.5),     # D4, slid down from Eb
    # phrase 4 -- cadence below and final long D
    (70.0, 3.0, 62, 0.0, 0.0),     # D4
    (73.5, 2.5, 60, 0.0, 0.0),     # C4
    (76.5, 3.0, 57, 0.0, 0.0),     # A3
    (80.0, 5.0, 62, -2.0, 0.8),    # D4, slid up from C -- final
]

MENU_BELLS = [(10.0, 0.9, -0.2), (33.0, 1.0, 0.2),
              (55.0, 0.85, -0.15), (78.0, 1.0, 0.25)]  # (t, vel, pan)

D2, A2, D3, D4_F = 73.416, 110.0, 146.832, 293.665


def gen_menu_theme():
    rng = np.random.default_rng(1453)  # fall of Constantinople
    n = int((MENU_LOOP_S + MENU_FADE_S) * SR)
    mix = np.zeros((n, 2))

    # drone bed: D root + fifth + faint octave, slow-moving detuned stacks
    mix += 0.52 * drone_bed([(D2, 1.0), (A2, 0.55), (D3, 0.28)], n, rng)

    # chant voice (mono stem, then centred with a distant stereo echo)
    chant = np.zeros(n)
    for start, dur, midi, slide, slide_t in MENU_MELODY:
        note = chant_note(midi, dur, slide, slide_t, rng)
        i = int(start * SR)
        j = min(n, i + len(note))
        chant[i:j] += note[: j - i]
    mix += 0.30 * stereo_echo(chant, n)

    # distant bell roughly every 22-23 s
    for t0, vel, pan in MENU_BELLS:
        add_pan(mix, bell_strike(D4_F, 9.0, rng), t0, pan=pan, gain=0.16 * vel)

    return crossfade_loop(mix, int(MENU_LOOP_S * SR), int(MENU_FADE_S * SR))


# ----------------------------------------------------------------------------
# 2) campaign_ambient.ogg  (~110 s loop) -- sparse in-game background
# ----------------------------------------------------------------------------

CAMP_LOOP_S = 110.0
CAMP_FADE_S = 2.0

# four short improvisatory D dorian phrases with long drone-only gaps
# (start_s, dur_s, midi, vel)
CAMP_PHRASES = [
    # phrase A -- low register, circling the final
    (8.0, 2.2, 50, 0.9), (9.4, 1.6, 53, 0.7), (10.6, 1.8, 55, 0.8),
    (12.2, 2.4, 57, 0.9), (14.4, 1.6, 55, 0.6), (15.8, 1.8, 53, 0.7),
    (17.4, 1.5, 52, 0.6), (18.8, 2.8, 50, 0.95),
    # phrase B -- up to the octave
    (34.0, 1.8, 57, 0.8), (35.6, 1.6, 60, 0.75), (37.0, 2.4, 62, 0.9),
    (39.6, 1.6, 60, 0.6), (41.0, 1.8, 57, 0.7), (42.6, 1.5, 55, 0.6),
    (44.0, 2.8, 57, 0.85),
    # phrase C -- highest point, then settle
    (62.0, 1.8, 62, 0.85), (63.8, 1.5, 64, 0.7), (65.2, 2.2, 65, 0.9),
    (67.6, 1.6, 62, 0.7), (69.2, 1.8, 60, 0.65), (71.0, 1.6, 57, 0.7),
    (72.6, 2.8, 55, 0.85),
    # phrase D -- descent home
    (90.0, 1.8, 53, 0.8), (91.6, 1.5, 55, 0.7), (93.0, 2.0, 57, 0.85),
    (95.2, 1.6, 55, 0.6), (96.6, 1.8, 53, 0.7), (98.2, 1.6, 52, 0.6),
    (99.6, 3.0, 50, 0.9),
]

CAMP_FRAME_DRUMS = [(27.5, 0.55, -0.1), (56.0, 0.5, 0.15), (85.5, 0.55, -0.05)]


def gen_campaign_ambient():
    rng = np.random.default_rng(1402)  # battle of Ankara
    n = int((CAMP_LOOP_S + CAMP_FADE_S) * SR)
    mix = np.zeros((n, 2))

    # drone bed, clearly below the menu level (this must sit behind SFX)
    mix += 0.30 * drone_bed([(D2, 1.0), (A2, 0.5)], n, rng, lfo_depth=0.30)

    # oud voice: mono stem with humanized timing, then subtle stereo echo
    oud = np.zeros(n)
    for start, dur, midi, vel in CAMP_PHRASES:
        t0 = start + rng.uniform(-0.03, 0.03)
        note = oud_note(midi, dur, rng, vel=vel)
        i = int(t0 * SR)
        j = min(n, i + len(note))
        oud[i:j] += note[: j - i]
    mix += 0.50 * stereo_echo(oud, n, gains=(0.12, 0.10),
                              delays=(0.150, 0.210), lp=2000.0)

    # very occasional soft frame-drum thump
    for t0, vel, pan in CAMP_FRAME_DRUMS:
        add_pan(mix, frame_drum(rng, vel=vel), t0, pan=pan, gain=0.22)

    return crossfade_loop(mix, int(CAMP_LOOP_S * SR), int(CAMP_FADE_S * SR))


# ----------------------------------------------------------------------------
# 3) battle_drums.ogg  (~81 s loop) -- war-drum ensemble overlay
# ----------------------------------------------------------------------------

BPM = 95.0
SPB = 60.0 / BPM          # seconds per beat
BARS = 32                 # loop = 32 bars of 4/4 at 95 BPM = 80.84 s
BATTLE_LOOP_S = BARS * 4 * SPB
BATTLE_FADE_S = 1.2

# dotted-eighth martial figure, (beat, velocity) within each bar
BIG_DRUM_BAR = [(0.00, 1.00), (0.75, 0.55), (1.00, 0.80),
                (2.00, 0.95), (2.75, 0.55), (3.00, 0.75)]
RIM_BAR = [(0.50, 0.50), (1.50, 0.70), (2.50, 0.50), (3.00, 0.40), (3.50, 0.80)]


def gen_battle_drums():
    rng = np.random.default_rng(1444)  # battle of Varna
    n = int((BATTLE_LOOP_S + BATTLE_FADE_S) * SR)
    mix = np.zeros((n, 2))

    # tense low drone: deep D1 + a beating D2/Eb2 minor-second pair
    Eb2 = D2 * 2.0 ** (1.0 / 12.0)
    mix += 0.20 * drone_bed([(36.708, 1.0), (D2, 0.55), (Eb2, 0.45)], n, rng,
                            tri_mix=0.25, lfo_depth=0.20)

    def jit(t):
        return t + rng.uniform(-0.006, 0.006)

    for bar in range(BARS):
        bar_t = bar * 4 * SPB
        sec = bar % 16
        accent = 1.18 if sec == 0 else 1.0
        stepup = sec >= 12  # last 4 bars of each 16-bar half

        # big drum, centre
        for beat, vel in BIG_DRUM_BAR:
            v = np.clip(vel * accent + rng.uniform(-0.06, 0.06), 0.2, 1.25)
            add_pan(mix, taiko_hit(rng, vel=v), jit(bar_t + beat * SPB),
                    pan=rng.uniform(-0.06, 0.06), gain=0.95)

        # second, slightly higher drum doubles beats 1 and 3, left of centre
        for beat in (0.0, 2.0):
            v = 0.6 + rng.uniform(-0.05, 0.05)
            add_pan(mix, taiko_hit(rng, vel=v, f_hi=100.0, f_lo=62.0,
                                   dur=0.6, t60=0.35),
                    jit(bar_t + beat * SPB + 0.012), pan=-0.28, gain=0.55)

        # rim/stick clicks, right of centre (extra ghost notes sometimes)
        rim_events = list(RIM_BAR)
        if rng.random() < 0.4:
            rim_events.append((1.75, 0.35))
        if rng.random() < 0.4:
            rim_events.append((3.75, 0.40))
        if sec == 15:  # 16th-note run into the next section
            rim_events += [(3.0 + k * 0.25, 0.5 + 0.1 * k) for k in range(4)]
        for beat, vel in rim_events:
            v = np.clip(vel + rng.uniform(-0.06, 0.06), 0.15, 1.0)
            add_pan(mix, rim_click(rng, vel=v), jit(bar_t + beat * SPB),
                    pan=0.35 + rng.uniform(-0.05, 0.05), gain=0.30)

        # intensity step-up: double-time low hits, crescendo over the 4 bars
        if stepup:
            for k in range(8):  # every eighth note
                prog = ((sec - 12) * 8 + k) / 32.0
                v = 0.45 + 0.35 * prog + rng.uniform(-0.04, 0.04)
                add_pan(mix, taiko_hit(rng, vel=v, f_hi=70.0, f_lo=45.0,
                                       dur=0.5, t60=0.30),
                        jit(bar_t + k * 0.5 * SPB),
                        pan=0.15 * (1 if k % 2 else -1), gain=0.55)

    return crossfade_loop(mix, int(BATTLE_LOOP_S * SR), int(BATTLE_FADE_S * SR))


# ----------------------------------------------------------------------------
# WAV writing / two-pass loudnorm OGG encoding / verification
# ----------------------------------------------------------------------------

def write_wav_stereo(path, x):
    x = np.clip(x, -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def loudnorm_encode(ffmpeg, wav_path, ogg_path):
    """Two-pass loudnorm (I=-16 LUFS, TP=-1.5, LRA=11). linear=true on the
    second pass applies a constant gain, preserving the loop seam. The
    filter runs at 192 kHz internally, so -ar 44100 restores our rate."""
    p1 = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", wav_path,
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    stats, _ = json.JSONDecoder().raw_decode(p1.stderr[p1.stderr.rindex("{"):])
    af = ("loudnorm=I=-16:TP=-1.5:LRA=11:"
          f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
          f"measured_LRA={stats['input_lra']}:"
          f"measured_thresh={stats['input_thresh']}:"
          f"offset={stats['target_offset']}:linear=true")
    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", wav_path,
         "-af", af, "-ar", str(SR),
         "-fflags", "+bitexact", "-flags:a", "+bitexact",
         "-c:a", "libvorbis", "-q:a", "4", ogg_path],
        check=True,
    )


def verify_ogg(ffmpeg, ogg_path):
    """Return (bytes, seconds) after checking a clean decode."""
    r = subprocess.run(
        [ffmpeg, "-v", "error", "-i", ogg_path, "-f", "null", "-"],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or r.stderr.strip():
        raise RuntimeError(f"decode check failed for {ogg_path}: {r.stderr}")
    r = subprocess.run(
        [ffmpeg, "-v", "error", "-i", ogg_path,
         "-f", "s16le", "-ac", "2", "-ar", str(SR), "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"raw decode failed for {ogg_path}")
    seconds = (len(r.stdout) // 4) / SR
    return os.path.getsize(ogg_path), seconds


def main():
    ffmpeg = get_ffmpeg()
    os.makedirs(MUSIC_DIR, exist_ok=True)

    tracks = [
        ("menu_theme.ogg", gen_menu_theme, MENU_LOOP_S),
        ("campaign_ambient.ogg", gen_campaign_ambient, CAMP_LOOP_S),
        ("battle_drums.ogg", gen_battle_drums, BATTLE_LOOP_S),
    ]

    results = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, gen, loop_s in tracks:
            print(f"rendering {name} ...", flush=True)
            x = gen()
            # loop integrity forbids trimming, so instead assert the track
            # attacks immediately: energy must be present in the first 10 ms
            head_peak = np.max(np.abs(x[: int(0.010 * SR)]))
            if head_peak < 1e-3 * np.max(np.abs(x)):
                raise RuntimeError(f"{name}: first 10 ms are silent")
            x = normalize(x, -1.0)
            wav_path = os.path.join(tmp, name.replace(".ogg", ".wav"))
            ogg_path = os.path.join(MUSIC_DIR, name)
            write_wav_stereo(wav_path, x)
            loudnorm_encode(ffmpeg, wav_path, ogg_path)
            size, seconds = verify_ogg(ffmpeg, ogg_path)
            if size >= SIZE_BUDGET:
                raise RuntimeError(f"{name}: {size} bytes exceeds 5 MB budget")
            if abs(seconds - loop_s) > 0.5:
                raise RuntimeError(
                    f"{name}: decoded {seconds:.2f} s, expected ~{loop_s:.2f} s")
            results.append((name, size, seconds))
            print(f"OK  {name:22s} {size:8d} bytes  {seconds:7.2f} s "
                  f"(loop target {loop_s:.2f} s)")

    print("all music tracks generated, verified and within budget")
    return results


if __name__ == "__main__":
    main()
