#!/bin/sh
# Télécharge Stable Audio Open 1.0 dans ComfyUI (DGX spark-1540), depuis la copie reconditionnée
# par ComfyUI (https://huggingface.co/Comfy-Org/stable-audio-open-1.0, sans restriction d'accès ni jeton).
# Usage : sh telecharger-stable-audio.sh
# Le dossier des modèles appartient à root : écriture par un conteneur jetable.
set -e
docker run --rm -v /home/amansouri/comfyui-data/models/checkpoints:/d openfilm-studio:sous-domaine-public sh -c '
  curl -sfL -o /d/stable-audio-open-1.0.safetensors.part \
    https://huggingface.co/Comfy-Org/stable-audio-open-1.0/resolve/main/stable-audio-open-1.0.safetensors &&
  mv /d/stable-audio-open-1.0.safetensors.part /d/stable-audio-open-1.0.safetensors &&
  ls -l /d/stable-audio-open-1.0.safetensors'
