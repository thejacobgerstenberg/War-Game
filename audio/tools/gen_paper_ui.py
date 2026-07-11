#!/usr/bin/env python3
"""Procedural paper/UI placeholder SFX generator for IMPERIUM: Twilight of Empires.

Synthesizes four original sounds entirely from seeded numpy noise + simple DSP
(RBJ biquad filters, exponential/hump envelopes, damped sines). No samples,
no third-party audio of any kind. Output is fully deterministic (fixed RNG
seeds), 44100 Hz mono, peak-normalized, encoded to OGG Vorbis via the ffmpeg
binary shipped in the imageio-ffmpeg wheel.

Generates into ../sfx (relative to this script):
  card_flip.ogg     ~0.25 s  noise swish (bandpass sweep 1->4 kHz) + crisp snap
  page_turn.ogg     ~0.60 s  two overlapping soft paper swishes (800 Hz-3 kHz)
  quill_scratch.ogg ~0.80 s  irregular high-band (3-7 kHz) scratch strokes
  ui_click.ogg      ~0.08 s  6 ms noise tick + damped 1.1 kHz "woody" body

Run standalone:  python3 gen_paper_ui.py
"""

import math
import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

SR = 44100
SEED = 42

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "sfx"))


def get_ffmpeg():
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


# ---------------------------------------------------------------------------
# DSP helpers (RBJ audio-EQ-cookbook biquads, direct form II transposed)
# ---------------------------------------------------------------------------

def _bp_coeffs(fc, q):
    """Bandpass, constant 0 dB peak gain."""
    w0 = 2.0 * math.pi * fc / SR
    alpha = math.sin(w0) / (2.0 * q)
    cosw = math.cos(w0)
    a0 = 1.0 + alpha
    return (alpha / a0, 0.0, -alpha / a0, -2.0 * cosw / a0, (1.0 - alpha) / a0)


def _hp_coeffs(fc, q=0.7071):
    w0 = 2.0 * math.pi * fc / SR
    alpha = math.sin(w0) / (2.0 * q)
    cosw = math.cos(w0)
    a0 = 1.0 + alpha
    b0 = (1.0 + cosw) / 2.0
    return (b0 / a0, -(1.0 + cosw) / a0, b0 / a0, -2.0 * cosw / a0, (1.0 - alpha) / a0)


def _lp_coeffs(fc, q=0.7071):
    w0 = 2.0 * math.pi * fc / SR
    alpha = math.sin(w0) / (2.0 * q)
    cosw = math.cos(w0)
    a0 = 1.0 + alpha
    b0 = (1.0 - cosw) / 2.0
    return (b0 / a0, (1.0 - cosw) / a0, b0 / a0, -2.0 * cosw / a0, (1.0 - alpha) / a0)


def biquad(x, coeffs):
    b0, b1, b2, a1, a2 = coeffs
    y = np.empty(len(x))
    z1 = z2 = 0.0
    for n in range(len(x)):
        xn = x[n]
        yn = b0 * xn + z1
        z1 = b1 * xn - a1 * yn + z2
        z2 = b2 * xn - a2 * yn
        y[n] = yn
    return y


def bandpass_sweep(x, fc_arr, q):
    """Time-varying bandpass: coefficients recomputed every sample."""
    y = np.empty(len(x))
    z1 = z2 = 0.0
    for n in range(len(x)):
        b0, b1, b2, a1, a2 = _bp_coeffs(fc_arr[n], q)
        xn = x[n]
        yn = b0 * xn + z1
        z1 = b1 * xn - a1 * yn + z2
        z2 = b2 * xn - a2 * yn
        y[n] = yn
    return y


def band(x, lo, hi, passes=2):
    """Static band-limit via cascaded HP(lo) + LP(hi) butterworth-Q biquads."""
    for _ in range(passes):
        x = biquad(x, _hp_coeffs(lo))
        x = biquad(x, _lp_coeffs(hi))
    return x


def hump(m, power=1.0):
    """Half-sine amplitude hump of m samples, raised to `power`."""
    return np.sin(np.pi * np.linspace(0.0, 1.0, m)) ** power


def fade_out(x, ms=4.0):
    k = min(len(x), int(SR * ms / 1000.0))
    if k > 0:
        x[-k:] *= np.linspace(1.0, 0.0, k)
    return x


def trim_lead(x, thresh_db=-60.0):
    """Trim leading silence so the attack starts at (near) the first sample."""
    peak = np.max(np.abs(x))
    if peak <= 0.0:
        return x
    thr = peak * (10.0 ** (thresh_db / 20.0))
    idx = np.argmax(np.abs(x) >= thr)
    return x[idx:]


def normalize(x, peak_dbfs=-1.0):
    peak = np.max(np.abs(x))
    if peak > 0.0:
        x = x * (10.0 ** (peak_dbfs / 20.0) / peak)
    return x


# ---------------------------------------------------------------------------
# Sound recipes
# ---------------------------------------------------------------------------

def make_card_flip():
    """~0.25 s: 120 ms rising noise swish (BP 1->4 kHz) into a crisp 8 ms snap."""
    rng = np.random.default_rng(SEED)
    n = int(0.25 * SR)
    out = np.zeros(n)

    # Swish: bandpassed noise, center frequency rising 1 kHz -> 4 kHz.
    ns = int(0.120 * SR)
    fc = np.geomspace(1000.0, 4000.0, ns)
    sw = bandpass_sweep(rng.standard_normal(ns), fc, q=2.0)
    t = np.linspace(0.0, 1.0, ns)
    sw *= (t ** 0.5) * (1.0 - 0.55 * t)  # fast build, slight taper into the snap
    out[:ns] += 0.55 * sw / max(np.max(np.abs(sw)), 1e-12)

    # Snap at ~118 ms: 8 ms high-passed click + tiny 900 Hz damped body.
    s0 = int(0.118 * SR)
    nc = int(0.008 * SR)
    click = rng.standard_normal(nc) * np.exp(-np.arange(nc) / (0.0016 * SR))
    click = biquad(biquad(click, _hp_coeffs(3000.0)), _hp_coeffs(3000.0))
    out[s0:s0 + nc] += 1.0 * click / max(np.max(np.abs(click)), 1e-12)

    nb = int(0.065 * SR)
    tb = np.arange(nb) / SR
    body = np.sin(2.0 * np.pi * 900.0 * tb) * np.exp(-tb / 0.011)
    out[s0:s0 + nb] += 0.30 * body

    return fade_out(out)


def make_page_turn():
    """~0.6 s: two overlapping soft filtered-noise swishes (800 Hz-3 kHz), no snap."""
    rng = np.random.default_rng(SEED + 1)
    n = int(0.60 * SR)
    out = np.zeros(n)

    def swish(length_s, gain):
        m = int(length_s * SR)
        x = band(rng.standard_normal(m), 800.0, 3000.0, passes=2)
        x *= hump(m, power=1.6)
        # Slow papery texture: interpolated random amplitude flutter (~35 Hz).
        k = max(4, int(length_s * 35.0))
        pts = rng.uniform(0.55, 1.0, k)
        x *= np.interp(np.linspace(0.0, k - 1.0, m), np.arange(k), pts)
        return gain * x / max(np.max(np.abs(x)), 1e-12)

    s1 = swish(0.34, 1.0)
    s2 = swish(0.36, 0.8)
    out[:len(s1)] += s1
    p2 = int(0.23 * SR)
    out[p2:p2 + len(s2)] += s2

    return fade_out(out, ms=12.0)


def make_quill_scratch():
    """~0.8 s: 5-7 irregular high-band scratch strokes with jittery micro-envelopes."""
    rng = np.random.default_rng(SEED + 2)
    n = int(0.80 * SR)
    out = np.zeros(n)

    n_strokes = int(rng.integers(5, 8))  # 5..7 (seeded, deterministic)
    tpos = 0.0
    for _ in range(n_strokes):
        length = float(rng.uniform(0.045, 0.110))
        m = int(length * SR)
        start = int(tpos * SR)
        if start + m > n:
            m = n - start
            if m < int(0.015 * SR):
                break
        x = band(rng.standard_normal(m), 3000.0, 7000.0, passes=2)
        # Jittery micro-envelope: random points interpolated at ~150-300 Hz.
        k = max(3, int((m / SR) * rng.uniform(150.0, 300.0)))
        pts = rng.uniform(0.12, 1.0, k)
        micro = np.interp(np.linspace(0.0, k - 1.0, m), np.arange(k), pts)
        x *= micro * hump(m, power=0.7)
        x *= float(rng.uniform(0.55, 1.0)) / max(np.max(np.abs(x)), 1e-12)
        out[start:start + m] += x
        tpos += length + float(rng.uniform(0.018, 0.060))  # tiny gap
        if tpos >= 0.80:
            break

    return fade_out(out, ms=8.0)


def make_ui_click():
    """~0.08 s: 6 ms band-limited noise tick + damped 1.1 kHz sine (woody, not beepy)."""
    rng = np.random.default_rng(SEED + 3)
    n = int(0.08 * SR)
    out = np.zeros(n)

    nc = int(0.006 * SR)
    tick = rng.standard_normal(nc) * np.exp(-np.arange(nc) / (0.0012 * SR))
    tick = band(tick, 1500.0, 6500.0, passes=1)
    out[:nc] += 0.9 * tick / max(np.max(np.abs(tick)), 1e-12)

    t = np.arange(n) / SR
    body = np.sin(2.0 * np.pi * 1100.0 * t) * np.exp(-t / 0.012)  # ~-36 dB by 50 ms
    body += 0.25 * np.sin(2.0 * np.pi * 1870.0 * t) * np.exp(-t / 0.006)  # woody overtone
    out += 0.55 * body

    return fade_out(out, ms=5.0)


# ---------------------------------------------------------------------------
# Render + encode + verify
# ---------------------------------------------------------------------------

RECIPES = [
    # (name, builder, target duration s, peak dBFS)
    ("card_flip", make_card_flip, 0.25, -1.0),
    ("page_turn", make_page_turn, 0.60, -6.0),  # spec: quieter than card_flip
    ("quill_scratch", make_quill_scratch, 0.80, -1.0),
    ("ui_click", make_ui_click, 0.08, -1.0),
]


def main():
    ff = get_ffmpeg()
    os.makedirs(OUT_DIR, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix="paper_ui_") as tmp:
        for name, builder, target_dur, peak_db in RECIPES:
            x = builder()
            x = trim_lead(x)
            x = normalize(x, peak_db)
            wav = os.path.join(tmp, name + ".wav")
            ogg = os.path.join(OUT_DIR, name + ".ogg")
            sf.write(wav, x.astype(np.float32), SR, subtype="PCM_16")

            subprocess.run(
                # -bitexact: reproducible OGG bytes (fixed Ogg stream serial, no
                # encoder version tag), so re-runs are byte-identical.
                [ff, "-y", "-v", "error", "-i", wav,
                 "-c:a", "libvorbis", "-q:a", "3", "-bitexact", ogg],
                check=True,
            )
            # Verify: clean decode, duration, size budget.
            dec = subprocess.run(
                [ff, "-v", "error", "-i", ogg, "-f", "null", "-"],
                capture_output=True, text=True,
            )
            if dec.returncode != 0 or dec.stderr.strip():
                raise RuntimeError(f"{name}.ogg failed decode check: {dec.stderr}")
            info = sf.info(ogg)
            dur = info.frames / info.samplerate
            size = os.path.getsize(ogg)
            if size >= 200 * 1024:
                raise RuntimeError(f"{name}.ogg over budget: {size} bytes")
            if abs(dur - target_dur) > 0.30 * target_dur:
                raise RuntimeError(f"{name}.ogg duration {dur:.3f}s vs target {target_dur}s")
            print(f"OK {name}.ogg  {size} bytes  {dur:.3f} s  peak target {peak_db} dBFS")
            results.append((ogg, dur, size))
    return results


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
