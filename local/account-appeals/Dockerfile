# Keep the appeal browser separate from upstream and the Codex CLI layer.
ARG ROUTER_IMAGE=9router:codex-trial
FROM ${ROUTER_IMAGE}
USER root
RUN sed -i 's|http://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends chromium fonts-noto-cjk xvfb xauth \
    && rm -rf /var/lib/apt/lists/*
ENV ACCOUNT_APPEAL_CHROMIUM=/usr/bin/chromium
ENV ACCOUNT_APPEAL_XVFB=/usr/bin/xvfb-run
