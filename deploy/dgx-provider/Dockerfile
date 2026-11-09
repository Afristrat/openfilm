# OpenFilm Studio (fork Afristrat/openfilm, branche dgx-0.3.1) sur DGX spark-1540, arm64.
# Vulkan sur la carte (navigateur de rendu) : libegl1 (glvnd) ici ET, au lancement, les fichiers de l'hôte montés en
# lecture seule : vulkan/icd.d/nvidia_icd.json, vulkan/implicit_layer.d/nvidia_layers.json, glvnd/egl_vendor.d/10_nvidia.json
# (sans l'un des deux, vkCreateInstance échoue : « Found no drivers », mesuré le 2026-11-09). Commande : run-studio.sh.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libvulkan1 libegl1 && rm -rf /var/lib/apt/lists/*
# yt-dlp pour « Importer depuis un lien » (studio/server/from-url.mjs) : version et empreinte fixées (SHA2-256SUMS de la
# version), binaire autonome arm64 (le DGX est aarch64) ; il lit YouTube avec Node (--js-runtimes node).
ARG YTDLP=2026.10.26
ARG YTDLP_SHA256=e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483
RUN curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP}/yt-dlp_linux_aarch64" \
  && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - && chmod 755 /usr/local/bin/yt-dlp
RUN npm i -g pnpm@10.30.3 && pnpm config set manage-package-manager-versions false --location=global
WORKDIR /opt/openfilm
ARG REF=dgx-0.3.1
# COMMIT : le commit attendu (--build-arg COMMIT=<sha>). Il change la couche, donc le clone est refait, et le clone est
# vérifié dessus : une image ne part jamais d'un autre état de la branche que celui annoncé.
ARG COMMIT=
RUN git clone --depth 1 -b "$REF" https://github.com/Afristrat/openfilm . \
  && { [ -z "$COMMIT" ] || [ "$(git rev-parse HEAD)" = "$COMMIT" ] || { echo "clone $(git rev-parse HEAD) au lieu de $COMMIT" >&2; exit 1; }; } \
  && pnpm install --frozen-lockfile
RUN cd packages/openfilm && npx playwright install-deps chromium
WORKDIR /opt/openfilm/packages/openfilm
ENV OPENFILM_STUDIO_PORT=4747 NVIDIA_DRIVER_CAPABILITIES=all
CMD ["node", "studio/server/main.mjs"]
