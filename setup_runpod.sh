#!/bin/bash
# Nemotron Nano 9B v2 Japanese — RunPod GPU Pod setup (one-command deploy)
#
# Usage:
#   export RUNPOD_API_KEY="rpa_..."
#   bash setup_runpod.sh
#
# Creates a GPU pod running vLLM with OpenAI-compatible API.
# Access: https://{POD_ID}-8000.proxy.runpod.net/v1/chat/completions

set -euo pipefail

: "${RUNPOD_API_KEY:?Set RUNPOD_API_KEY}"

MODEL="nvidia/NVIDIA-Nemotron-Nano-9B-v2-Japanese"
GPU="NVIDIA RTX A5000"  # 24GB VRAM, fits 9B BF16

echo "Creating RunPod GPU pod..."
RESULT=$(curl -s "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation { podFindAndDeployOnDemand(input: { name: \\\"nemotron-9b\\\", imageName: \\\"vllm/vllm-openai:v0.12.0\\\", gpuTypeId: \\\"${GPU}\\\", cloudType: SECURE, gpuCount: 1, volumeInGb: 50, containerDiskInGb: 30, dockerArgs: \\\"--model ${MODEL} --trust-remote-code --mamba_ssm_cache_dtype float32 --max-num-seqs 32 --max-model-len 8192 --gpu-memory-utilization 0.90 --dtype bfloat16 --host 0.0.0.0 --port 8000\\\", ports: \\\"8000/http\\\", volumeMountPath: \\\"/root/.cache/huggingface\\\", startJupyter: false, startSsh: true }) { id } }\"
  }")

POD_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['podFindAndDeployOnDemand']['id'])")
echo "Pod ID: $POD_ID"
echo "URL:    https://${POD_ID}-8000.proxy.runpod.net"
echo ""
echo "Waiting for vLLM to start (model download ~5min, load ~3min)..."

for i in $(seq 1 60); do
  sleep 15
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${POD_ID}-8000.proxy.runpod.net/health" --max-time 5 2>/dev/null || echo "000")
  printf "\r  [%3ds] HTTP %s" $((i*15)) "$CODE"
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "Ready!"
    echo ""
    echo "Test:"
    echo "  curl https://${POD_ID}-8000.proxy.runpod.net/v1/chat/completions \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"日本の首都は？\"}],\"max_tokens\":256}'"
    exit 0
  fi
done

echo ""
echo "Timeout — pod may still be loading. Check: https://${POD_ID}-8000.proxy.runpod.net/health"
