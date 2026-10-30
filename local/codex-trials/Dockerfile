# Add the installed CLI runtime to an already-built 9router image.
# Supply --build-context codex-runtime=/path/to/vendor/x86_64-unknown-linux-musl.
# syntax=docker/dockerfile:1.7
ARG ROUTER_IMAGE=9router:codex-trial-base
FROM ${ROUTER_IMAGE}
COPY --from=codex-runtime / /opt/codex/
RUN test "$(/opt/codex/bin/codex --version)" = "codex-cli 0.166.0"
ENV CODEX_TRIAL_CLI=/opt/codex/bin/codex
ENV CODEX_TRIAL_RUNTIME=/opt/codex
