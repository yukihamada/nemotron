"""
ACE-Step 1.5 Music Generation — RunPod Serverless Handler
Generates instrumental/vocal music from text prompts.
"""
import runpod
import base64
import io
import os
import sys
import tempfile

print("=== ACE-Step handler starting ===", flush=True)

_model = None

def _get_model():
    global _model
    if _model is not None:
        return _model
    print("[init] Loading ACE-Step...", flush=True)
    from ace_step.pipeline import ACEStepPipeline
    _model = ACEStepPipeline()
    print("[init] ACE-Step ready", flush=True)
    return _model


def handler(job: dict) -> dict:
    inp = job.get("input", {})
    prompt = inp.get("prompt", "").strip()
    if not prompt:
        return {"error": "prompt is required"}

    # Quick health check
    if prompt == "__ping__":
        return {"status": "ok", "message": "ace-step alive"}

    lyrics = inp.get("lyrics", "")
    duration = min(max(float(inp.get("duration", 30)), 5), 240)
    instrumental = inp.get("instrumental", True)
    fmt = inp.get("format", "mp3")

    try:
        model = _get_model()

        audio, sr = model(
            prompt=prompt,
            lyrics=lyrics if not instrumental else "[instrumental]",
            duration=duration,
            # ACE-Step 1.5 params
            infer_step=60,
            guidance_scale=15,
            scheduler_type="euler",
            cfg_type="apg",
            omega=10,
        )

        # audio is a numpy array, sr is sample rate
        import numpy as np
        import subprocess

        # Save as WAV first
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_wav.close()

        import soundfile as sf
        sf.write(tmp_wav.name, audio[0] if audio.ndim > 1 else audio, sr)

        # Convert to requested format
        if fmt in ("mp3", "ogg"):
            tmp_out = tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False)
            tmp_out.close()
            subprocess.run(
                ["ffmpeg", "-y", "-i", tmp_wav.name, "-b:a", "128k", tmp_out.name],
                capture_output=True, timeout=30,
            )
            os.unlink(tmp_wav.name)
            with open(tmp_out.name, "rb") as f:
                audio_bytes = f.read()
            os.unlink(tmp_out.name)
        else:
            with open(tmp_wav.name, "rb") as f:
                audio_bytes = f.read()
            os.unlink(tmp_wav.name)
            fmt = "wav"

        return {
            "audio_base64": base64.b64encode(audio_bytes).decode(),
            "format": fmt,
            "duration": duration,
            "sample_rate": sr,
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


print("=== Registering ACE-Step handler ===", flush=True)
runpod.serverless.start({"handler": handler})
