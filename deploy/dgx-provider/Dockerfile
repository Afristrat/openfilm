# OpenFilm Studio (fork Afristrat/openfilm, branche sous-domaine-public) sur DGX spark-1540, arm64.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libvulkan1 && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10.30.3 && pnpm config set manage-package-manager-versions false --location=global
WORKDIR /opt/openfilm
ARG REF=sous-domaine-public
RUN git clone --depth 1 -b "$REF" https://github.com/Afristrat/openfilm . && pnpm install --frozen-lockfile
RUN cd packages/openfilm && npx playwright install-deps chromium
WORKDIR /opt/openfilm/packages/openfilm
ENV OPENFILM_STUDIO_PORT=4747 NVIDIA_DRIVER_CAPABILITIES=all
CMD ["node", "studio/server/main.mjs"]
