#!/usr/bin/env python3
"""Procedural ambience-SFX generator for IMPERIUM: Twilight of Empires.

Synthesizes three placeholder ambience loops/beds entirely from numpy DSP
(no third-party audio, no samples — 100% original procedural work):

    audio/sfx/battle_distant.ogg  (~4.5 s, loopable) far-off battle over walls
    audio/sfx/ship_creak.ogg      (~3.0 s)           wooden hull at sea
    audio/sfx/crowd_murmur.ogg    (~4.5 s, loopable) council-hall murmur

Deterministic: fixed RNG seed (42). Output: 44100 Hz mono, peak-normalized
to -1 dBFS, no leading silence, encoded to OGG Vorbis (-q:a 3) with the
ffmpeg binary shipped in the imageio-ffmpeg wheel.

Loopable sounds are rendered 250 ms long, then the tail is equal-power
crossfaded into the head so the loop point is click-free.

Run standalone:  python3 audio/tools/gen_ambience.py
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
LOOP_XFADE_S = 0.25

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
# DSP primitives (pure numpy / stdlib — no scipy in this env)
# ----------------------------------------------------------------------------

def biquad(x, b0, b1, b2, a1, a2):
    """Direct-form-II-transposed biquad, per-sample loop."""
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


def tv_bandpass(x, f0_arr, q):
    """Time-varying resonant band-pass: RBJ 'bp' with the center frequency
    recomputed every sample from f0_arr. Used for the creak glide."""
    y = np.empty_like(x)
    z1 = 0.0
    z2 = 0.0
    two_pi_over_sr = 2.0 * math.pi / SR
    for n in range(len(x)):
        w0 = two_pi_over_sr * f0_arr[n]
        cw = math.cos(w0)
        alpha = math.sin(w0) / (2.0 * q)
        a0 = 1.0 + alpha
        b0 = alpha / a0
        b2 = -alpha / a0
        a1 = -2.0 * cw / a0
        a2 = (1.0 - alpha) / a0
        xn = x[n]
        yn = b0 * xn + z1
        z1 = -a1 * yn + z2  # b1 == 0 for the bp form
        z2 = b2 * xn - a2 * yn
        y[n] = yn
    return y


def brown_noise(n, rng):
    """Integrated white noise, demeaned and peak-normalized (drift removed
    later by a high-pass)."""
    b = np.cumsum(rng.standard_normal(n))
    b -= np.mean(b)
    b /= max(1e-9, np.max(np.abs(b)))
    return b


def pinkish_noise(n, rng):
    """FFT-domain 1/sqrt(f) spectral shaping — close enough to pink for a
    wave-wash bed, and fully deterministic."""
    spec = rng.standard_normal(n // 2 + 1) + 1j * rng.standard_normal(n // 2 + 1)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    f[0] = f[1]  # avoid div-by-zero at DC
    spec /= np.sqrt(f)
    spec[0] = 0.0  # kill DC
    x = np.fft.irfft(spec, n)
    return x / max(1e-9, np.max(np.abs(x)))


def exp_decay(n, tau_s):
    return np.exp(-np.arange(n) / (tau_s * SR))


def damped_sine(freq, dur_s, tau_s, phase=0.0):
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    return np.sin(2 * math.pi * freq * t + phase) * exp_decay(n, tau_s)


def mix_at(buf, sig, t_s, gain=1.0):
    i = int(round(t_s * SR))
    if i >= len(buf):
        return
    m = min(len(sig), len(buf) - i)
    buf[i : i + m] += gain * sig[:m]


def smooth_control(n, n_points, lo, hi, rng):
    """Slowly varying control curve: random points interpolated over n
    samples, then lightly smoothed with a moving average."""
    pts = rng.uniform(lo, hi, n_points)
    xp = np.linspace(0, n - 1, n_points)
    curve = np.interp(np.arange(n), xp, pts)
    win = max(1, int(0.15 * SR))
    kern = np.ones(win) / win
    return np.convolve(curve, kern, mode="same")


def moving_rms_env(x, win_s):
    """Smoothed amplitude envelope via moving average of |x|."""
    win = max(1, int(win_s * SR))
    kern = np.ones(win) / win
    return np.convolve(np.abs(x), kern, mode="same")


def loop_crossfade(x, fade_s=LOOP_XFADE_S):
    """Equal-power crossfade of the last fade_s into the first fade_s, then
    drop the tail. Result length = len(x) - fade_s*SR; the sample after the
    new last sample is exactly the new first sample, so it loops clean."""
    nf = int(fade_s * SR)
    body = x[:-nf].copy()
    tail = x[-nf:]
    t = np.linspace(0.0, math.pi / 2.0, nf)
    body[:nf] = body[:nf] * np.sin(t) + tail * np.cos(t)
    return body


def peak_normalize(x, peak_dbfs=-1.0):
    m = np.max(np.abs(x))
    if m > 0:
        x = x * (10.0 ** (peak_dbfs / 20.0) / m)
    return x


def trim_leading(x, thresh=1e-3, pre_ms=2.0):
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

def gen_battle_distant(rng):
    """~4.5 s loop: far-off battle heard over city walls.
    Layers: brown-noise rumble bed LP'd at 500 Hz with slow undulation;
    sparse muffled clash/boom hits (quiet inharmonic ring + low thud,
    heavily low-passed) at irregular times; faint roaring-crowd layer
    (slowly amplitude-modulated 300-1200 Hz noise). Tail is crossfaded
    into the head for click-free looping."""
    gen_s = 4.5 + LOOP_XFADE_S
    n = int(gen_s * SR)
    t = np.arange(n) / SR

    # --- rumble bed: brown noise, band-limited 25-500 Hz, slow undulation
    bed = brown_noise(n, rng)
    bed = lowpass(bed, 500.0)
    bed = highpass(bed, 25.0)
    und = (1.0
           + 0.18 * np.sin(2 * math.pi * 0.23 * t + float(rng.uniform(0, 2 * math.pi)))
           + 0.12 * np.sin(2 * math.pi * 0.11 * t + float(rng.uniform(0, 2 * math.pi))))
    bed *= und
    bed /= max(1e-9, np.max(np.abs(bed)))

    # --- faint roaring crowd: 300-1200 Hz noise, slow random swells
    roar = rng.standard_normal(n)
    roar = highpass(roar, 300.0)
    roar = lowpass(roar, 1200.0)
    roar_env = smooth_control(n, 9, 0.25, 1.0, rng)
    roar *= roar_env
    roar /= max(1e-9, np.max(np.abs(roar)))

    buf = 1.0 * bed + 0.28 * roar

    # --- sparse muffled clash/boom hits at irregular times
    def muffled_hit():
        # low thud: pitch-dropping damped sine (boom through stone)
        th_n = int(0.55 * SR)
        tt = np.arange(th_n) / SR
        f = 55.0 + 35.0 * np.exp(-tt / 0.07)
        phase = 2 * math.pi * np.cumsum(f) / SR
        thud = np.sin(phase) * exp_decay(th_n, 0.16)
        # quiet inharmonic ring (distant metal), fast decays
        ring = np.zeros(th_n)
        for pf, pa in ((417.0, 1.0), (683.0, 0.7), (1054.0, 0.45)):
            fd = pf * float(rng.uniform(0.99, 1.01))
            ring += pa * damped_sine(fd, 0.55, float(rng.uniform(0.06, 0.16)),
                                     phase=float(rng.uniform(0, 2 * math.pi)))[:th_n]
        hit = thud + 0.4 * ring
        # heavily low-passed: it happened far away, behind walls
        hit = lowpass(hit, 650.0)
        hit = lowpass(hit, 900.0)
        return hit

    t_hit = 0.30 + float(rng.uniform(0.0, 0.25))
    while t_hit < gen_s - 0.65:
        buf_gain = 0.55 * float(rng.uniform(0.5, 1.0))
        mix_at(buf, muffled_hit(), t_hit, gain=buf_gain)
        t_hit += float(rng.uniform(0.55, 1.20))

    # gentle saturation glues the layers, then loop it
    buf = np.tanh(1.3 * buf) / math.tanh(1.3)
    return loop_crossfade(buf)


def gen_ship_creak(rng):
    """~3 s: wooden hull at sea. Two slow stick-slip creaks — high-Q
    band-pass whose center glides 180→320 Hz and back, driven by jittery
    (sample-and-hold-modulated) noise; underneath, a gentle wave wash of
    pink-ish noise LP'd at 900 Hz with one slow swell. Ends clean."""
    total = 3.0
    n = int(total * SR)
    t = np.arange(n) / SR

    # --- wave wash: pink-ish noise, LP 900 Hz, one slow swell
    wash = pinkish_noise(n, rng)
    wash = lowpass(wash, 900.0)
    swell = 0.35 + 0.65 * np.exp(-0.5 * ((t - 1.35) / 0.65) ** 2)  # one swell ~1.35 s
    wash *= swell
    wash /= max(1e-9, np.max(np.abs(wash)))

    buf = 0.45 * wash

    # --- stick-slip creaks
    def creak(dur_s, f_lo, f_hi, q, jitter_hz):
        nc = int(dur_s * SR)
        u = np.arange(nc) / nc
        # center glides f_lo -> f_hi -> f_lo (half-sine trajectory)
        f_arr = f_lo + (f_hi - f_lo) * np.sin(math.pi * u)
        # jittery excitation: white noise gated by sample-and-hold jitter
        hold = max(1, int(SR / jitter_hz))
        n_holds = nc // hold + 1
        jit = rng.uniform(0.0, 1.0, n_holds) ** 2  # spiky slip amplitudes
        jitter = np.repeat(jit, hold)[:nc]
        exc = rng.standard_normal(nc) * (0.20 + 0.80 * jitter)
        y = tv_bandpass(exc, f_arr, q)
        y /= max(1e-9, np.max(np.abs(y)))
        # groan envelope: eased attack and release
        env = np.sin(math.pi * u) ** 0.8
        return y * env

    mix_at(buf, creak(1.20, 180.0, 320.0, 24.0, 110.0), 0.20, gain=1.00)
    mix_at(buf, creak(1.00, 195.0, 310.0, 19.0, 90.0), 1.62, gain=0.80)

    # end clean: cosine fade over the last 220 ms
    nf = int(0.22 * SR)
    buf[-nf:] *= 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, nf)))
    return buf


def gen_crowd_murmur(rng):
    """~4.5 s loop: council-hall murmur, no intelligible speech. 14-ish
    overlapping voice-band blobs: 300 Hz-3 kHz noise given a formant-like
    double band-pass and 3-6 Hz syllabic amplitude modulation, each blob
    0.3-1.2 s, stratified-random placement; a soft leveler keeps the
    overall level very even; tail crossfaded into head for looping."""
    gen_s = 4.5 + LOOP_XFADE_S
    n = int(gen_s * SR)

    # --- continuous low murmur bed so gaps never go dead
    bed = rng.standard_normal(n)
    bed = highpass(bed, 300.0)
    bed = lowpass(bed, 3000.0)
    bed /= max(1e-9, np.max(np.abs(bed)))
    buf = 0.14 * bed

    # --- voice blobs, stratified over the timeline for even coverage
    n_blobs = int(rng.integers(12, 17))
    for i in range(n_blobs):
        start = (i + float(rng.uniform(0.0, 0.85))) / n_blobs * (gen_s - 0.30)
        dur = float(rng.uniform(0.3, 1.2))
        nb = int(dur * SR)
        tb = np.arange(nb) / SR

        src = rng.standard_normal(nb)
        src = highpass(src, 300.0)   # voice band 300 Hz - 3 kHz
        src = lowpass(src, 3000.0)
        # formant-like double band-pass (F1 + F2), a hint of broadband body
        f1 = float(rng.uniform(350.0, 800.0))
        f2 = float(rng.uniform(1000.0, 2400.0))
        blob = (bandpass(src, f1, q=8.0)
                + 0.8 * bandpass(src, f2, q=10.0)
                + 0.20 * src)
        # syllabic 3-6 Hz amplitude modulation (speech-like gating)
        fs = float(rng.uniform(3.0, 6.0))
        ph = float(rng.uniform(0, 2 * math.pi))
        am = 0.30 + 0.70 * (0.5 + 0.5 * np.sin(2 * math.pi * fs * tb + ph)) ** 1.6
        blob *= am * np.hanning(nb)
        blob /= max(1e-9, np.max(np.abs(blob)))
        mix_at(buf, blob, start, gain=float(rng.uniform(0.5, 1.0)))

    # --- soft leveler: divide by a smoothed envelope (partial strength)
    env = moving_rms_env(buf, 0.25)
    target = np.mean(env)
    env = np.maximum(env, 0.25 * target)
    buf *= (target / env) ** 0.7
    buf = np.tanh(1.5 * buf) / math.tanh(1.5)
    return loop_crossfade(buf)


# ----------------------------------------------------------------------------
# Render + encode + verify
# ----------------------------------------------------------------------------

# (name, generator, target duration s, loopable)
RECIPES = [
    ("battle_distant", gen_battle_distant, 4.5, True),
    ("ship_creak", gen_ship_creak, 3.0, False),
    ("crowd_murmur", gen_crowd_murmur, 4.5, True),
]


def main():
    ff = get_ffmpeg()
    os.makedirs(SFX_DIR, exist_ok=True)
    rng = np.random.default_rng(SEED)
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, fn, target_dur, loopable in RECIPES:
            audio = fn(rng)
            audio = peak_normalize(audio)
            if loopable:
                # never trim a loopable — it would break head/tail continuity.
                # The noise bed guarantees the sound is audible from sample 0.
                first_ms = np.max(np.abs(audio[: int(0.010 * SR)]))
                if first_ms <= 1e-3:
                    raise RuntimeError(f"{name}: silent first 10 ms in a loop")
            else:
                audio = trim_leading(audio)
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
            dec = subprocess.run(
                [ff, "-v", "error", "-i", ogg, "-f", "null", "-"],
                capture_output=True, text=True,
            )
            if dec.returncode != 0 or dec.stderr.strip():
                raise RuntimeError(f"{name}: decode check failed: {dec.stderr}")
            size = os.path.getsize(ogg)
            dur = len(audio) / SR
            head_rms = float(np.sqrt(np.mean(audio[: int(0.1 * SR)] ** 2)))
            tail_rms = float(np.sqrt(np.mean(audio[-int(0.1 * SR):] ** 2)))
            results.append(
                (os.path.relpath(ogg, REPO_ROOT), dur, size, target_dur,
                 loopable, head_rms, tail_rms)
            )

    for rel, dur, size, target, loopable, hr, tr in results:
        extra = (f", loop head/tail RMS {hr:.3f}/{tr:.3f}" if loopable
                 else ", one-shot (clean end)")
        print(f"{rel}: {dur:.3f}s (target ~{target}s), {size} bytes — "
              f"decode OK{extra}")


if __name__ == "__main__":
    sys.exit(main())
