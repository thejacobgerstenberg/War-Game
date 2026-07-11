#!/usr/bin/env python3
"""Procedural tonal-SFX generator for IMPERIUM: Twilight of Empires.

Synthesizes three placeholder game sounds entirely from numpy DSP
(no third-party audio, no samples -- 100% original procedural work):

    audio/sfx/church_bell.ogg   (~3.5 s) one church bell strike, left to ring
    audio/sfx/horn_fanfare.ogg  (~2.5 s) short two-voice brass victory fanfare
    audio/sfx/coin_purse.ogg    (~0.7 s) purse of coins dropped in the palm

Recipes
-------
church_bell : additive synthesis over a 330 Hz prime with the classic bell
    partial ratios (hum 0.5x, prime 1.0x, tierce 1.2x, quint 1.5x,
    nominal 2.0x, plus 2.67x and 3.01x). Lower partials decay slowly
    (T60 2.5-3.5 s), upper ones fast (0.3-1 s). A 15 ms band-passed noise
    burst forms the clapper strike, and the hum + prime are built as
    detuned pairs (~1-2 Hz apart) for the characteristic slow beating.

horn_fanfare : each note is 10 harmonics with a soft low-pass rolloff,
    a 30 ms harmonic-staggered attack blur and 5 Hz vibrato fading in
    after 150 ms. Melody rises G4-C5-E5-G5 (quarter, quarter, quarter,
    held); a quieter harmony voice joins a third below on the last two
    notes (C5, E5). A 120 ms / 3-repeat decaying delay adds hall feel.

coin_purse : a soft 40 ms cloth thud (low-passed noise) followed by
    randomized tiny metallic chinks over ~400 ms; each chink is 2-3
    inharmonic partials in the 4-9 kHz band with a 30-80 ms decay.

Deterministic: fixed RNG seed (42). Output: 44100 Hz mono, peak-normalized
to -1 dBFS, leading silence trimmed, encoded to OGG Vorbis (-q:a 3) with
the ffmpeg binary shipped in the imageio-ffmpeg wheel.

Run standalone:  python3 audio/tools/gen_tonal.py
"""

import math
import os
import struct
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 44100
SEED = 42

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SFX_DIR = os.path.join(REPO_ROOT, "audio", "sfx")

FFMPEG_FALLBACK = (
    "/root/.local/lib/python3.11/site-packages/imageio_ffmpeg/binaries/"
    "ffmpeg-linux-x86_64-v7.0.2"
)


def get_ffmpeg():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return FFMPEG_FALLBACK


# ----------------------------------------------------------------------------
# DSP primitives (pure numpy -- scipy is not installed in this environment,
# so noise filtering is done in the FFT domain with Butterworth-style
# magnitude responses; everything stays fully vectorized)
# ----------------------------------------------------------------------------

def fft_lowpass(x, fc, order=2):
    """Zero-phase FFT-domain low-pass (Butterworth-like magnitude)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1.0 / SR)
    H = 1.0 / np.sqrt(1.0 + (f / fc) ** (2 * order))
    return np.fft.irfft(X * H, n=len(x))


def fft_bandpass(x, f_lo, f_hi, order=2):
    """Zero-phase FFT-domain band-pass (HP at f_lo, LP at f_hi)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1.0 / SR)
    with np.errstate(divide="ignore"):
        hp = 1.0 / np.sqrt(1.0 + (f_lo / np.maximum(f, 1e-9)) ** (2 * order))
    lp = 1.0 / np.sqrt(1.0 + (f / f_hi) ** (2 * order))
    return np.fft.irfft(X * hp * lp, n=len(x))


def exp_env(n, t60):
    """Exponential decay reaching -60 dB at t60 seconds."""
    t = np.arange(n) / SR
    return np.exp(-6.9078 * t / t60)


def raised_cos_attack(n_total, attack_s):
    """Unity envelope with a raised-cosine fade-in of attack_s seconds."""
    env = np.ones(n_total)
    na = max(1, min(n_total, int(attack_s * SR)))
    env[:na] = 0.5 - 0.5 * np.cos(np.pi * np.arange(na) / na)
    return env


def fade_out(x, fade_s):
    """In-place raised-cosine fade-out on the final fade_s seconds."""
    nf = min(len(x), int(fade_s * SR))
    if nf > 0:
        x[-nf:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(nf) / nf)
    return x


def normalize(x, peak_db=-1.0):
    """Peak-normalize to peak_db dBFS."""
    peak = np.max(np.abs(x))
    if peak > 0:
        x = x * (10.0 ** (peak_db / 20.0) / peak)
    return x


def trim_leading_silence(x, thresh_db=-60.0):
    """Cut everything before the first sample above thresh_db (rel. peak)."""
    peak = np.max(np.abs(x))
    if peak <= 0:
        return x
    thresh = peak * (10.0 ** (thresh_db / 20.0))
    idx = np.argmax(np.abs(x) >= thresh)
    return x[idx:]


# ----------------------------------------------------------------------------
# 1) church_bell.ogg  (~3.5 s)
# ----------------------------------------------------------------------------

def gen_church_bell(rng):
    dur = 3.5
    n = int(dur * SR)
    t = np.arange(n) / SR
    f0 = 330.0  # prime

    # (ratio, relative amplitude, T60 seconds, beat detune in Hz or 0)
    # hum & prime get a detuned pair for slow beating; T60s taper from the
    # slow lower partials (2.5-3.5 s) to the fast upper ones (0.3-1 s).
    partials = [
        (0.50, 0.55, 3.5, 1.2),   # hum       (beating pair, 1.2 Hz)
        (1.00, 1.00, 3.0, 1.8),   # prime     (beating pair, 1.8 Hz)
        (1.20, 0.65, 2.5, 0.0),   # tierce (minor third)
        (1.50, 0.50, 1.7, 0.0),   # quint
        (2.00, 0.60, 1.0, 0.0),   # nominal
        (2.67, 0.30, 0.6, 0.0),   # upper partial
        (3.01, 0.22, 0.35, 0.0),  # upper partial
    ]

    bell = np.zeros(n)
    for ratio, amp, t60, beat in partials:
        f = f0 * ratio
        env = exp_env(n, t60)
        phase = rng.uniform(0.0, 2.0 * math.pi)
        if beat > 0.0:
            # two oscillators detuned +/- beat/2 -> amplitude beating at `beat` Hz
            a = np.sin(2 * np.pi * (f - beat / 2.0) * t + phase)
            b = np.sin(2 * np.pi * (f + beat / 2.0) * t + rng.uniform(0, 2 * math.pi))
            bell += amp * env * 0.5 * (a + b)
        else:
            bell += amp * env * np.sin(2 * np.pi * f * t + phase)

    # 2 ms micro-attack on the tonal body to avoid a click at sample zero
    bell *= raised_cos_attack(n, 0.002)

    # 15 ms clapper strike: band-passed noise burst around the upper partials
    ns = int(0.015 * SR)
    strike = np.zeros(n)
    burst = rng.standard_normal(ns) * exp_env(ns, 0.012)
    strike[:ns] = burst
    strike = fft_bandpass(strike, 1200.0, 6500.0, order=2)
    bell += 0.9 * strike / max(np.max(np.abs(strike)), 1e-12)

    fade_out(bell, 0.15)
    return bell


# ----------------------------------------------------------------------------
# 2) horn_fanfare.ogg  (~2.5 s)
# ----------------------------------------------------------------------------

# equal-tempered note frequencies
G4, C5, E5, G5 = 392.00, 523.25, 659.25, 783.99


def brass_note(f0, dur, rng, release=0.08):
    """One brass-like note: 10 harmonics, soft LP rolloff, 30 ms attack
    blur (upper harmonics enter slightly later), 5 Hz vibrato after 150 ms."""
    n = int(dur * SR)
    t = np.arange(n) / SR

    # vibrato: 5 Hz, ~0.4% depth, fading in from 150 ms to 400 ms
    vib_gate = np.clip((t - 0.15) / 0.25, 0.0, 1.0)
    f_inst = f0 * (1.0 + 0.004 * vib_gate * np.sin(2 * np.pi * 5.0 * t))
    base_phase = 2 * np.pi * np.cumsum(f_inst) / SR

    note = np.zeros(n)
    for h in range(1, 11):
        # soft low-pass rolloff: gentle 1/h tilt plus a ~2.2 kHz corner
        amp = (1.0 / h ** 0.8) / (1.0 + (h * f0 / 2200.0) ** 2)
        # attack blur: higher harmonics bloom a little later (30 ms base)
        atk = 0.030 * (1.0 + 0.10 * (h - 1))
        note += amp * raised_cos_attack(n, atk) * np.sin(h * base_phase)

    # gentle sustain decay + raised-cosine release
    note *= np.exp(-0.35 * t)
    nr = min(n, int(release * SR))
    note[-nr:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(nr) / nr)
    return note


def feedback_delay(x, delay_s, repeats, gain):
    """Simple decaying delay tail (feedback loop truncated at `repeats`)."""
    d = int(delay_s * SR)
    out = np.zeros(len(x) + repeats * d)
    out[: len(x)] = x
    for k in range(1, repeats + 1):
        out[k * d : k * d + len(x)] += (gain ** k) * x
    return out


def gen_horn_fanfare(rng):
    q = 0.42  # quarter-note duration (s)
    melody = [(G4, 0.0, q + 0.03), (C5, q, q + 0.03),
              (E5, 2 * q, q + 0.03), (G5, 3 * q, 0.95)]
    harmony = [(C5, 2 * q, q + 0.03), (E5, 3 * q, 0.95)]  # a third below

    total = 3 * q + 0.95
    n = int(total * SR)
    mix = np.zeros(n)

    for f, start, dur in melody:
        note = brass_note(f, dur, rng, release=0.25 if dur > 0.5 else 0.08)
        i = int(start * SR)
        mix[i : i + len(note)] += note
    for f, start, dur in harmony:
        note = brass_note(f, dur, rng, release=0.25 if dur > 0.5 else 0.08)
        i = int(start * SR)
        mix[i : i + len(note)] += 0.6 * note

    # hall feel: 120 ms delay, 3 decaying repeats
    mix = feedback_delay(mix, 0.120, 3, 0.32)
    fade_out(mix, 0.12)
    return mix


# ----------------------------------------------------------------------------
# 3) coin_purse.ogg  (~0.7 s)
# ----------------------------------------------------------------------------

def gen_coin_purse(rng):
    dur = 0.70
    n = int(dur * SR)
    out = np.zeros(n)

    # soft 40 ms cloth thud: low-passed noise with a fast decay
    nt = int(0.080 * SR)  # segment; energy is concentrated in first ~40 ms
    thud = rng.standard_normal(nt) * exp_env(nt, 0.055)
    thud = fft_lowpass(thud, 260.0, order=2)
    thud *= raised_cos_attack(nt, 0.003)
    out[:nt] += 0.95 * thud / max(np.max(np.abs(thud)), 1e-12)

    # 10-14 tiny metallic chinks over ~400 ms (clustered toward the impact)
    n_chinks = int(rng.integers(10, 15))
    for _ in range(n_chinks):
        onset = 0.025 + 0.40 * rng.beta(1.2, 2.0)
        n_part = int(rng.integers(2, 4))          # 2-3 inharmonic partials
        t60 = rng.uniform(0.030, 0.080)           # 30-80 ms decay
        level = rng.uniform(0.30, 1.0) * (1.0 - 0.45 * onset / 0.425)

        seg_n = int(t60 * SR)
        ts = np.arange(seg_n) / SR
        chink = np.zeros(seg_n)
        for _p in range(n_part):
            f = rng.uniform(4000.0, 9000.0)       # 4-9 kHz metallic band
            a = rng.uniform(0.4, 1.0)
            chink += a * np.sin(2 * np.pi * f * ts + rng.uniform(0, 2 * math.pi))
        chink *= exp_env(seg_n, t60) * raised_cos_attack(seg_n, 0.001)
        chink *= level / max(np.max(np.abs(chink)), 1e-12)

        i = int(onset * SR)
        j = min(n, i + seg_n)
        out[i:j] += 0.40 * chink[: j - i]

    fade_out(out, 0.04)
    return out


# ----------------------------------------------------------------------------
# WAV writing / OGG encoding / verification
# ----------------------------------------------------------------------------

def write_wav(path, x):
    x = np.clip(x, -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def encode_ogg(ffmpeg, wav_path, ogg_path):
    # bitexact flags keep the Ogg container serial deterministic, so repeated
    # runs of this script produce byte-identical files (verified).
    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", wav_path,
         "-fflags", "+bitexact", "-flags:a", "+bitexact",
         "-c:a", "libvorbis", "-q:a", "3", ogg_path],
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
    # duration: decode to raw s16le and count samples
    r = subprocess.run(
        [ffmpeg, "-v", "error", "-i", ogg_path,
         "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"raw decode failed for {ogg_path}")
    seconds = (len(r.stdout) // 2) / SR
    return os.path.getsize(ogg_path), seconds


def main():
    rng = np.random.default_rng(SEED)
    ffmpeg = get_ffmpeg()
    os.makedirs(SFX_DIR, exist_ok=True)

    recipes = [
        ("church_bell.ogg", gen_church_bell, 3.5),
        ("horn_fanfare.ogg", gen_horn_fanfare, 2.5),
        ("coin_purse.ogg", gen_coin_purse, 0.7),
    ]

    results = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, gen, target_s in recipes:
            x = gen(rng)
            x = trim_leading_silence(x)
            x = normalize(x, -1.0)
            wav_path = os.path.join(tmp, name.replace(".ogg", ".wav"))
            ogg_path = os.path.join(SFX_DIR, name)
            write_wav(wav_path, x)
            encode_ogg(ffmpeg, wav_path, ogg_path)
            size, seconds = verify_ogg(ffmpeg, ogg_path)
            if size >= 200 * 1024:
                raise RuntimeError(f"{name}: {size} bytes exceeds 200 KB budget")
            results.append((name, size, seconds, target_s))
            print(f"OK  {name:18s} {size:7d} bytes  {seconds:5.2f} s "
                  f"(target ~{target_s} s)")

    print("all files generated, verified and within budget")
    return results


if __name__ == "__main__":
    main()
