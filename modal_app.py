"""
Nemotron Nano 9B v2 Japanese — Modal + vLLM OpenAI-compatible API.

Deploy:  modal deploy modal_app.py
Test:    modal run modal_app.py
Logs:    modal app logs nemotron-nano-9b

Endpoints:
  POST /v1/chat/completions  — Chat (streaming supported)
  POST /v1/completions       — Text completion
  GET  /v1/models            — Model list
  GET  /health               — Health check
"""

import modal

MODEL_ID = "nvidia/NVIDIA-Nemotron-Nano-9B-v2-Japanese"
MODEL_DIR = "/models/nemotron-nano-9b-v2-japanese"

vllm_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("vllm>=0.12", "torch", "transformers", "huggingface_hub", "fastapi[standard]")
    .run_commands(
        f'python3 -c "from huggingface_hub import snapshot_download; '
        f"snapshot_download('{MODEL_ID}', local_dir='{MODEL_DIR}')\""
    )
)

app = modal.App("nemotron-nano-9b", image=vllm_image)


@app.function(gpu="A10G", min_containers=0, scaledown_window=300, timeout=600)
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def web():
    import json, time, uuid
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, StreamingResponse
    from vllm import AsyncEngineArgs, AsyncLLMEngine, SamplingParams

    fastapi_app = FastAPI(title="Nemotron Nano 9B v2 Japanese")
    fastapi_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    engine = AsyncLLMEngine.from_engine_args(AsyncEngineArgs(
        model=MODEL_DIR, trust_remote_code=True, dtype="bfloat16",
        max_model_len=32768, max_num_seqs=64, gpu_memory_utilization=0.92,
    ))

    def _sampling(body: dict) -> SamplingParams:
        return SamplingParams(
            temperature=body.get("temperature", 0.7), top_p=body.get("top_p", 0.9),
            max_tokens=body.get("max_tokens", 1024), stop=body.get("stop"),
            repetition_penalty=body.get("repetition_penalty", 1.0),
            presence_penalty=body.get("presence_penalty", 0.0),
            frequency_penalty=body.get("frequency_penalty", 0.0),
        )

    async def _stream(engine, prompt, params, rid):
        prev = ""
        async for out in engine.generate(prompt, params, rid):
            if out.outputs:
                delta = out.outputs[0].text[len(prev):]
                prev = out.outputs[0].text
                if delta:
                    yield f"data: {json.dumps({'id': rid, 'object': 'chat.completion.chunk', 'model': MODEL_ID, 'choices': [{'index': 0, 'delta': {'content': delta}, 'finish_reason': None}]}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'id': rid, 'object': 'chat.completion.chunk', 'model': MODEL_ID, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
        yield "data: [DONE]\n\n"

    @fastapi_app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        body = await request.json()
        messages = body.get("messages", [])
        if not messages:
            raise HTTPException(400, "messages is required")
        params = _sampling(body)
        rid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        tokenizer = await engine.get_tokenizer()
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        if body.get("stream"):
            return StreamingResponse(_stream(engine, prompt, params, rid), media_type="text/event-stream")
        async for out in engine.generate(prompt, params, rid):
            final = out
        text = final.outputs[0].text if final.outputs else ""
        return JSONResponse({"id": rid, "object": "chat.completion", "created": int(time.time()), "model": MODEL_ID,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": len(final.prompt_token_ids), "completion_tokens": len(final.outputs[0].token_ids) if final.outputs else 0, "total_tokens": len(final.prompt_token_ids) + (len(final.outputs[0].token_ids) if final.outputs else 0)}})

    @fastapi_app.post("/v1/completions")
    async def completions(request: Request):
        body = await request.json()
        prompt = body.get("prompt", "")
        if not prompt:
            raise HTTPException(400, "prompt is required")
        params = _sampling(body)
        rid = f"cmpl-{uuid.uuid4().hex[:12]}"
        async for out in engine.generate(prompt, params, rid):
            final = out
        text = final.outputs[0].text if final.outputs else ""
        return JSONResponse({"id": rid, "object": "text_completion", "created": int(time.time()), "model": MODEL_ID,
            "choices": [{"index": 0, "text": text, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": len(final.prompt_token_ids), "completion_tokens": len(final.outputs[0].token_ids) if final.outputs else 0, "total_tokens": len(final.prompt_token_ids) + (len(final.outputs[0].token_ids) if final.outputs else 0)}})

    @fastapi_app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "nvidia"}]}

    @fastapi_app.get("/health")
    async def health():
        return {"status": "ok", "model": MODEL_ID, "engine": "vllm", "max_model_len": 32768, "gpu": "A10G"}

    return fastapi_app


@app.local_entrypoint()
def main():
    print(f"Deploy: modal deploy modal_app.py")
    print(f"Test:   curl <URL>/v1/chat/completions -H 'Content-Type: application/json' -d '{{\"model\":\"{MODEL_ID}\",\"messages\":[{{\"role\":\"user\",\"content\":\"こんにちは\"}}]}}'")
