#!/bin/sh
# Lance (ou relance) le conteneur Studio sur DGX spark-1540. Usage : sh run-studio.sh [tag de l'image, défaut 0.3.1]
# Studio n'écoute que 127.0.0.1 (réseau de l'hôte) ; film.ai-mpower.com y arrive par le relais SSH de serveuria.
set -e
TAG="${1:-0.3.1}"
docker rm -f openfilm-studio >/dev/null 2>&1 || true
docker run -d --name openfilm-studio --restart unless-stopped --network host --gpus all --device /dev/dri --memory 24g \
  -v openfilm-home:/root \
  -v /usr/share/vulkan/icd.d/nvidia_icd.json:/usr/share/vulkan/icd.d/nvidia_icd.json:ro \
  -v /usr/share/vulkan/implicit_layer.d/nvidia_layers.json:/usr/share/vulkan/implicit_layer.d/nvidia_layers.json:ro \
  -v /usr/share/glvnd/egl_vendor.d/10_nvidia.json:/usr/share/glvnd/egl_vendor.d/10_nvidia.json:ro \
  -e OPENFILM_PUBLIC_ORIGIN=https://film.ai-mpower.com \
  -e OPENFILM_PUBLIC_FILM_ORIGIN=https://film-apercu.ai-mpower.com \
  "openfilm-studio:$TAG"
