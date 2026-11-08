#!/bin/sh
# Télécharge Stable Audio Open 1.0 dans ComfyUI (DGX spark-1540), une fois l'accès accepté sur
# https://huggingface.co/stabilityai/stable-audio-open-1.0 avec le compte medamine77.
# Usage : HF_TOKEN=... sh telecharger-stable-audio.sh  (le jeton vient du coffre, jamais affiché).
# Le dossier des modèles appartient à root : écriture par un conteneur jetable.
set -e
: "${HF_TOKEN:?HF_TOKEN manquant}"
docker run --rm -e HF_TOKEN -v /home/amansouri/comfyui-data/models/checkpoints:/d openfilm-studio:sous-domaine-public sh -c '
  curl -sfL -H "Authorization: Bearer $HF_TOKEN" -o /d/stable-audio-open-1.0.safetensors.part \
    https://huggingface.co/stabilityai/stable-audio-open-1.0/resolve/main/model.safetensors &&
  mv /d/stable-audio-open-1.0.safetensors.part /d/stable-audio-open-1.0.safetensors &&
  ls -l /d/stable-audio-open-1.0.safetensors'
