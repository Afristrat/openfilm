#!/bin/sh
# Lance (ou relance) le conteneur Studio sur DGX spark-1540. Usage : sh run-studio.sh [tag de l'image, défaut 0.3.1]
# Studio n'écoute que 127.0.0.1 (réseau de l'hôte) ; film.ai-mpower.com y arrive par le relais SSH de serveuria.
# Agent du panneau (studio/server/agent.mjs) : passerelle LiteLLM d'AI-MPower, modèle local ; sa clé (alias openfilm-agent,
# bornée à ce modèle) est dans le volume, /root/.openfilm/agent/litellm.key, jamais dans ce fichier.
# Plafonds (SOP-020) : 24 Go de mémoire, 4096 processus (18 au repos mesurés le 2026-11-09 ; le rendu lance Chromium et ffmpeg).
set -e
TAG="${1:-0.3.1}"
docker rm -f openfilm-studio >/dev/null 2>&1 || true
docker run -d --name openfilm-studio --restart unless-stopped --network host --gpus all --device /dev/dri --memory 24g --pids-limit 4096 \
  -v openfilm-home:/root \
  -v /usr/share/vulkan/icd.d/nvidia_icd.json:/usr/share/vulkan/icd.d/nvidia_icd.json:ro \
  -v /usr/share/vulkan/implicit_layer.d/nvidia_layers.json:/usr/share/vulkan/implicit_layer.d/nvidia_layers.json:ro \
  -v /usr/share/glvnd/egl_vendor.d/10_nvidia.json:/usr/share/glvnd/egl_vendor.d/10_nvidia.json:ro \
  -e OPENFILM_PUBLIC_ORIGIN=https://film.ai-mpower.com \
  -e OPENFILM_PUBLIC_FILM_ORIGIN=https://film-apercu.ai-mpower.com \
  -e OPENFILM_AGENT_BASE_URL=https://proxy.ai-mpower.com/v1 \
  -e OPENFILM_AGENT_MODEL=qwen3.8-27b \
  -e "OPENFILM_AGENT_NAME=Qwen 3.8 27B (DGX, sans vision)" \
  "openfilm-studio:$TAG"
