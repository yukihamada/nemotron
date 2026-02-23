FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cu121

RUN pip3 install --no-cache-dir \
    ace-step \
    runpod \
    soundfile \
    numpy

WORKDIR /app
COPY handler.py .

# Pre-download model at build time (faster cold starts)
RUN python3 -c "from ace_step.pipeline import ACEStepPipeline; ACEStepPipeline()" || true

CMD ["python3", "handler.py"]
