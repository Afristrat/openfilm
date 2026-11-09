#!/bin/sh
# Télécharge les modèles d'effets sonores dans ComfyUI (DGX spark-1540), depuis les copies reconditionnées par ComfyUI,
# sans restriction d'accès ni jeton : Stable Audio 3 Small SFX + son encodeur t5gemma (https://huggingface.co/Comfy-Org/stable-audio-3,
# modèle par défaut) et Stable Audio Open 1.0 (https://huggingface.co/Comfy-Org/stable-audio-open-1.0, second choix ;
# son encodeur t5_base.safetensors est déjà dans text_encoders/).
# Usage : sh telecharger-stable-audio.sh
# Le dossier des modèles appartient à root : écriture par un conteneur jetable. Reprise et nouvelles tentatives en cas de coupure.
set -e
docker run --rm -v /home/amansouri/comfyui-data/models:/m openfilm-studio:0.3.1-gpu sh -c '
  get() { [ -f "$2" ] || { curl -sfL --retry 8 --retry-all-errors -C - -o "$2.part" "$1" && mv "$2.part" "$2"; }; }
  SA3=https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main
  get $SA3/checkpoints/stable_audio_3_small_sfx.safetensors /m/checkpoints/stable_audio_3_small_sfx.safetensors
  get $SA3/text_encoders/t5gemma_b_b_ul2.safetensors /m/text_encoders/t5gemma_b_b_ul2.safetensors
  get https://huggingface.co/Comfy-Org/stable-audio-open-1.0/resolve/main/stable-audio-open-1.0.safetensors /m/checkpoints/stable-audio-open-1.0.safetensors
  ls -l /m/checkpoints/stable_audio_3_small_sfx.safetensors /m/text_encoders/t5gemma_b_b_ul2.safetensors /m/checkpoints/stable-audio-open-1.0.safetensors'
