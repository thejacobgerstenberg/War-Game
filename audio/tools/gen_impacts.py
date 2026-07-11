#!/usr/bin/env python3
"""Procedural impact-SFX generator for IMPERIUM: Twilight of Empires.

Synthesizes four placeholder game sounds entirely from numpy DSP
(no third-party audio, no samples — 100% original procedural work):

    audio/sfx/dice_roll.ogg     (~1.2 s) dice tumbling on wood
    audio/sfx/sword_clash.ogg   (~0.8 s) two-blade metallic clash
    audio/sfx/bombard_shot.ogg  (~2.0 s) medieval great-bombard boom
    audio/sfx/defeat_drum.ogg   (~1.4 s) two somber low tom hits

Deterministic: fixed RNG seed (42). Output: 44100 Hz mono, peak-normalized
to -1 dBFS, leading silence trimmed, encoded to OGG Vorbis (-q:a 3) with
the ffmpeg binary shipped in the imageio-ffmpeg wheel.

Run standalone:  python3 audio/tools/gen_impacts.py
"""

import math
import os
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
# DSP primitives (pure numpy / stdlib — no scipy available in this env)
# ----------------------------------------------------------------------------

def biquad(x, b0, b1, b2, a1, a2):
    """Direct-form-II-transposed biquad, per-sample loop (fine for short SFX)."""
    y = np.empty_like(x)
    z1 = 0.0
    z2 = 0.0
    for n in range(len(x)):
        xn = x[n]
        yn = b0 * xn + z1
        z1 = b1 * xn - a1 * yn + z2
        z2 = b2 * xn - a2 * yn
        y[n] = yn
    return y


def _rbj(x, ftype, f0, q):
    """RBJ audio-EQ-cookbook biquad: 'lp', 'hp' or 'bp' (constant peak gain)."""
    w0 = 2.0 * math.pi * f0 / SR
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2.0 * q)
    if ftype == "lp":
        b0 = (1 - cw) / 2
        b1 = 1 - cw
        b2 = (1 - cw) / 2
    elif ftype == "hp":
        b0 = (1 + cw) / 2
        b1 = -(1 + cw)
        b2 = (1 + cw) / 2
    elif ftype == "bp":
        b0 = alpha
        b1 = 0.0
        b2 = -alpha
    else:
        raise ValueError(ftype)
    a0 = 1 + alpha
    a1 = -2 * cw
    a2 = 1 - alpha
    return biquad(x, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)


def lowpass(x, f0, q=0.7071):
    return _rbj(x, "lp", f0, q)


def highpass(x, f0, q=0.7071):
    return _rbj(x, "hp", f0, q)


def bandpass(x, f0, q=4.0):
    return _rbj(x, "bp", f0, q)


def exp_decay(n, tau_s):
    """Exponential decay envelope over n samples with time constant tau_s."""
    return np.exp(-np.arange(n) / (tau_s * SR))


def damped_sine(freq, dur_s, tau_s, phase=0.0):
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    return np.sin(2 * math.pi * freq * t + phase) * exp_decay(n, tau_s)


def mix_at(buf, sig, t_s, gain=1.0):
    """Add sig into buf starting at time t_s (clipped to buffer end)."""
    i = int(round(t_s * SR))
    if i >= len(buf):
        return
    m = min(len(sig), len(buf) - i)
    buf[i : i + m] += gain * sig[:m]


def normalize_and_trim(x, peak_dbfs=-1.0, thresh=1e-3, pre_ms=2.0):
    """Peak-normalize to peak_dbfs, then trim leading silence so the
    attack lands within the first few ms."""
    m = np.max(np.abs(x))
    if m > 0:
        x = x * (10.0 ** (peak_dbfs / 20.0) / m)
    above = np.nonzero(np.abs(x) > thresh)[0]
    if len(above):
        start = max(0, above[0] - int(pre_ms * 1e-3 * SR))
        x = x[start:]
    return x


def write_wav(path, x):
    pcm = np.clip(x, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ----------------------------------------------------------------------------
# Sound recipes
# ----------------------------------------------------------------------------

def gen_dice_roll(rng):
    """~1.2 s: 6-9 short band-passed noise clicks (2-5 kHz, 10-25 ms), each
    paired with a damped 180-260 Hz knock; tumble timing accelerates then
    settles; ends with a rest thump."""
    total = 1.2
    buf = np.zeros(int(total * SR))

    n_bursts = int(rng.integers(7, 10))  # 7..9 tumbles before the rest
    # Accelerating-then-settling gaps: shrink to a mid-roll minimum, then
    # stretch back out as the dice lose energy and come to rest.
    gaps = []
    for k in range(n_bursts - 1):
        u = k / max(1, n_bursts - 2)  # 0..1
        base = 0.130 - 0.075 * math.sin(math.pi * min(u, 1.0))  # 130→55→130 ms
        gaps.append(base * float(rng.uniform(0.85, 1.2)))
    times = np.concatenate(([0.0], np.cumsum(gaps)))

    for i, t0 in enumerate(times):
        # hard-surface click: band-passed noise burst
        dur = float(rng.uniform(0.010, 0.025))
        cf = float(rng.uniform(2000.0, 5000.0))
        n = int(dur * SR)
        click = rng.standard_normal(n)
        click = bandpass(click, cf, q=3.5)
        click *= exp_decay(n, dur / 3.0)
        # low wood knock under the click
        kf = float(rng.uniform(180.0, 260.0))
        knock = damped_sine(kf, 0.09, 0.018, phase=float(rng.uniform(0, math.pi)))
        lvl = float(rng.uniform(0.55, 1.0))
        # tumbles fade a touch as energy dissipates
        fade = 1.0 - 0.35 * (i / max(1, len(times) - 1))
        mix_at(buf, click, t0, gain=0.9 * lvl * fade)
        mix_at(buf, knock, t0, gain=0.5 * lvl * fade)

    # final rest thump: heavier, lower, slightly after the last tumble
    t_rest = times[-1] + float(rng.uniform(0.10, 0.14))
    thump = damped_sine(150.0, 0.16, 0.035)
    thump[: int(0.10 * SR)] += 0.5 * damped_sine(210.0, 0.10, 0.02, phase=1.1)
    settle_n = int(0.012 * SR)
    settle = bandpass(rng.standard_normal(settle_n), 2600.0, q=3.0)
    settle *= exp_decay(settle_n, 0.004)
    mix_at(buf, thump, t_rest, gain=0.95)
    mix_at(buf, settle, t_rest, gain=0.45)
    return buf


def gen_sword_clash(rng):
    """~0.8 s: inharmonic metallic partials (2.3/3.1/4.7/6.2 kHz) with fast
    exponential decays + 10 ms broadband strike transient; a detuned duplicate
    15 ms later gives the two-blade feel."""
    total = 0.8
    buf = np.zeros(int(total * SR))
    partials = [2300.0, 3100.0, 4700.0, 6200.0]
    decays = [float(rng.uniform(0.08, 0.30)) for _ in partials]
    amps = [1.0, 0.8, 0.6, 0.45]

    def one_blade(detune, tau_scale):
        blade = np.zeros(len(buf))
        for f, tau, a in zip(partials, decays, amps):
            fd = f * detune * float(rng.uniform(0.998, 1.002))
            blade += a * damped_sine(fd, total, tau * tau_scale,
                                     phase=float(rng.uniform(0, 2 * math.pi)))
        # faint low body of the blades
        blade += 0.25 * damped_sine(620.0 * detune, total, 0.06)
        return blade

    # strike transient: 10 ms of bright broadband noise
    strike_n = int(0.010 * SR)
    strike = rng.standard_normal(strike_n)
    strike = highpass(strike, 1500.0)
    strike *= exp_decay(strike_n, 0.003)

    mix_at(buf, strike, 0.0, gain=1.2)
    mix_at(buf, one_blade(1.0, 1.0), 0.0, gain=0.9)
    # second blade: slightly detuned, 15 ms later, a touch quieter
    strike2 = rng.standard_normal(strike_n)
    strike2 = highpass(strike2, 2000.0)
    strike2 *= exp_decay(strike_n, 0.0025)
    mix_at(buf, strike2, 0.015, gain=0.8)
    mix_at(buf, one_blade(1.013, 0.85), 0.015, gain=0.7)
    return buf


def gen_bombard_shot(rng):
    """~2.0 s: 40 ms noise blast + 110→35 Hz sine sweep over 300 ms +
    brown-noise rumble low-passed at 300 Hz decaying over 1.5 s, gentle tanh
    saturation, faint echo tail."""
    total = 2.0
    n_total = int(total * SR)
    buf = np.zeros(n_total)

    # 40 ms broadband blast
    blast_n = int(0.040 * SR)
    blast = rng.standard_normal(blast_n)
    blast = lowpass(blast, 5000.0)
    blast *= exp_decay(blast_n, 0.012)
    mix_at(buf, blast, 0.0, gain=1.0)

    # low sine sweep 110 Hz -> 35 Hz over 300 ms (phase-integrated),
    # with an amplitude decay so it melts into the rumble
    sweep_n = int(0.5 * SR)
    tt = np.arange(sweep_n) / SR
    freq = np.where(tt < 0.3, 110.0 + (35.0 - 110.0) * (tt / 0.3), 35.0)
    phase = 2 * math.pi * np.cumsum(freq) / SR
    sweep = np.sin(phase) * exp_decay(sweep_n, 0.16)
    mix_at(buf, sweep, 0.0, gain=1.1)

    # brown-noise rumble: integrated white noise, LP at 300 Hz, 1.5 s decay
    rum_n = int(1.7 * SR)
    brown = np.cumsum(rng.standard_normal(rum_n))
    brown -= np.mean(brown)
    brown /= max(1e-9, np.max(np.abs(brown)))
    brown = lowpass(brown, 300.0)
    brown = highpass(brown, 25.0)  # keep sub-sonic drift out
    brown *= exp_decay(rum_n, 0.45)  # ~-13 dB at 1.5 s
    mix_at(buf, brown, 0.005, gain=0.9)

    # gentle tanh saturation for weight
    buf = np.tanh(1.6 * buf) / math.tanh(1.6)

    # faint echo tail (two soft delayed reflections, darkened)
    echo = lowpass(buf.copy(), 1200.0)
    out = buf.copy()
    mix_at(out, echo, 0.23, gain=0.22)
    mix_at(out, echo, 0.47, gain=0.10)
    return out[:n_total]


def gen_defeat_drum(rng):
    """~1.4 s: two somber low tom hits (100→70 Hz pitch drop + noise skin
    transient), second softer, ~0.6 s apart, dark and dry."""
    total = 1.4
    buf = np.zeros(int(total * SR))

    def tom_hit():
        n = int(0.7 * SR)
        tt = np.arange(n) / SR
        # pitch drops 100 -> 70 Hz exponentially (~90 ms glide)
        freq = 70.0 + 30.0 * np.exp(-tt / 0.09)
        phase = 2 * math.pi * np.cumsum(freq) / SR
        body = np.sin(phase) * exp_decay(n, 0.16)
        body += 0.3 * np.sin(2.0 * phase + 0.7) * exp_decay(n, 0.07)  # skin overtone
        # skin/stick transient: short dark noise
        sk_n = int(0.012 * SR)
        skin = rng.standard_normal(sk_n)
        skin = lowpass(skin, 1800.0)
        skin *= exp_decay(sk_n, 0.004)
        hit = body
        hit[:sk_n] += 0.5 * skin
        return hit

    mix_at(buf, tom_hit(), 0.0, gain=1.0)
    mix_at(buf, tom_hit(), 0.62, gain=0.62)  # second hit, softer
    # keep it dark and dry
    buf = lowpass(buf, 2500.0)
    return buf


# ----------------------------------------------------------------------------
# Render + encode + verify
# ----------------------------------------------------------------------------

RECIPES = [
    ("dice_roll", gen_dice_roll, 1.2),
    ("sword_clash", gen_sword_clash, 0.8),
    ("bombard_shot", gen_bombard_shot, 2.0),
    ("defeat_drum", gen_defeat_drum, 1.4),
]


def main():
    ff = get_ffmpeg()
    os.makedirs(SFX_DIR, exist_ok=True)
    rng = np.random.default_rng(SEED)
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, fn, target_dur in RECIPES:
            audio = fn(rng)
            audio = normalize_and_trim(audio)
            wav = os.path.join(tmp, name + ".wav")
            ogg = os.path.join(SFX_DIR, name + ".ogg")
            write_wav(wav, audio)
            subprocess.run(
                # -fflags +bitexact: deterministic Ogg stream serial + no
                # version-stamped metadata, so reruns are byte-identical.
                [ff, "-y", "-i", wav, "-c:a", "libvorbis", "-q:a", "3",
                 "-fflags", "+bitexact", ogg],
                check=True, capture_output=True,
            )
            # verify clean decode
            dec = subprocess.run(
                [ff, "-v", "error", "-i", ogg, "-f", "null", "-"],
                capture_output=True, text=True,
            )
            if dec.returncode != 0 or dec.stderr.strip():
                raise RuntimeError(f"{name}: decode check failed: {dec.stderr}")
            size = os.path.getsize(ogg)
            dur = len(audio) / SR
            results.append((os.path.relpath(ogg, REPO_ROOT), dur, size, target_dur))

    for rel, dur, size, target in results:
        print(f"{rel}: {dur:.3f}s (target ~{target}s), {size} bytes — decode OK")


if __name__ == "__main__":
    sys.exit(main())
