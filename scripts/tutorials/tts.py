# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["qwen-tts==0.1.1", "torch==2.14.1+cpu", "torchaudio==2.11.0+cpu", "soundfile", "numpy"]
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# torchaudio = { index = "pytorch-cpu" }
# ///
"""Narration for the help films: one WAV per line, with Qwen3-TTS (CustomVoice).

    node scripts/tutorials/lines.mjs > lines.json
    uv run scripts/tutorials/tts.py --model 1.7B --speaker aiden --lines lines.json --out wav/

A built-in voice, rendered on this machine's CPU (the 1.7B model at about six
seconds per second of speech): no voice is cloned and no text leaves it.

`lines.json` is a list of {"id": "S1-03", "text": "..."}; each becomes <out>/<id>.wav,
with the words it was rendered from beside it in <out>/<id>.txt. A line whose WAV
was rendered from the same words is skipped, so a run can be resumed; one whose
words have changed since is rendered again, and `record.mjs` refuses a WAV whose
words are not its step's.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

INSTRUCT = "Speak calmly and clearly, at a measured, unhurried pace, like a patient teacher explaining a screen."


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["0.6B", "1.7B"], required=True)
    ap.add_argument("--speaker", required=True)
    ap.add_argument("--lines", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=8)
    args = ap.parse_args()
    if args.threads < 1:
        print("--threads must be at least 1", file=sys.stderr)
        return 2

    torch.set_num_threads(args.threads)
    os.makedirs(args.out, exist_ok=True)
    with open(args.lines, encoding="utf-8") as f:
        lines = json.load(f)
    if not isinstance(lines, list) or not all("id" in x and "text" in x for x in lines):
        print("lines.json must be a list of {id, text}", file=sys.stderr)
        return 2

    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(f"Qwen/Qwen3-TTS-12Hz-{args.model}-CustomVoice", dtype=torch.float32)
    speakers = model.get_supported_speakers()
    print(f"loaded in {time.time() - t0:.0f}s; speakers: {speakers}", flush=True)
    if args.speaker.lower() not in speakers:
        print(f"--speaker must be one of: {', '.join(speakers)}", file=sys.stderr)
        return 2

    for line in lines:
        path = os.path.join(args.out, f"{line['id']}.wav")
        said = os.path.join(args.out, f"{line['id']}.txt")
        if os.path.exists(path) and os.path.exists(said):
            with open(said, encoding="utf-8") as f:
                if f.read() == line["text"]:
                    continue
        t = time.time()
        wavs, sr = model.generate_custom_voice(
            text=line["text"],
            language="English",
            speaker=args.speaker,
            instruct=INSTRUCT if args.model == "1.7B" else None,
        )
        audio = np.asarray(wavs[0], dtype=np.float32)
        sf.write(path, audio, sr)
        with open(said, "w", encoding="utf-8") as f:
            f.write(line["text"])
        took = time.time() - t
        print(f"{line['id']}: {len(audio) / sr:.1f}s of speech in {took:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
