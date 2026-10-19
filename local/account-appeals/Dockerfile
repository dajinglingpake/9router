# Keep the appeal browser separate from upstream and the Codex CLI layer.
ARG ROUTER_IMAGE=9router:codex-trial
FROM ${ROUTER_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV ACCOUNT_APPEAL_CHROMIUM=/usr/bin/chromium
