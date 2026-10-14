# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper==1.2.1", "requests", "soundfile", "scipy"]
# ///
"""Transcribe narration WAVs and compare them with the script, word by word.

    uv run scripts/tutorials/asr_check.py --lines lines.json --wav <dir> [--only id,id] [--threads N]

Prints each line's word error rate against its text, and flags lines above
the threshold — the TTS sometimes drops or garbles a phrase, and nobody should
hear that in a tutorial.
"""
import argparse
import json
import os
import re
import sys

import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel
from scipy.signal import resample_poly


def samples16k(path: str) -> np.ndarray:
    # Decoded here rather than by faster-whisper, whose own decoder (PyAV)
    # breaks against the current PyAV release.
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if sr == 16000:
        return mono
    g = np.gcd(sr, 16000)
    return resample_poly(mono, 16000 // g, sr // g).astype(np.float32)


# A transcript writes "15" where the script says "fifteen": the same word.
NUMBERS = {w: str(i) for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen twenty".split()
)}
NUMBERS.update({"thirty": "30", "forty": "40", "fifty": "50", "sixty": "60", "hundred": "100"})


def words(s: str) -> list[str]:
    return [NUMBERS.get(w, w) for w in re.sub(r"[^a-z0-9' ]+", " ", s.lower().replace("’", "'")).split()]


def wer(ref: list[str], hyp: list[str]) -> float:
    d = [[0] * (len(hyp) + 1) for _ in range(len(ref) + 1)]
    for i in range(len(ref) + 1):
        d[i][0] = i
    for j in range(len(hyp) + 1):
        d[0][j] = j
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]))
    return d[len(ref)][len(hyp)] / max(1, len(ref))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", required=True)
    ap.add_argument("--wav", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--threshold", type=float, default=0.15)
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    if a.threads < 1:
        print("--threads must be at least 1", file=sys.stderr)
        return 2
    with open(a.lines, encoding="utf-8") as f:
        lines = json.load(f)
    only = set(filter(None, a.only.split(",")))
    model = WhisperModel("large-v3", device="cpu", compute_type="int8", cpu_threads=a.threads)
    bad = 0
    for line in lines:
        if only and line["id"] not in only:
            continue
        path = os.path.join(a.wav, f"{line['id']}.wav")
        if not os.path.exists(path):
            print(f"{line['id']}: MISSING")
            bad += 1
            continue
        segs, _ = model.transcribe(samples16k(path), language="en", beam_size=5)
        heard = " ".join(s.text.strip() for s in segs)
        rate = wer(words(line["text"]), words(heard))
        flag = "BAD " if rate > a.threshold else "ok  "
        bad += rate > a.threshold
        print(f"{flag}{line['id']}: wer {rate:.2f} | heard: {heard}")
    print(f"{bad} line(s) over {a.threshold}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
