# AutoVPN execution container.
#
# Cloudflare Containers run a real linux/amd64 VM, so this image is not a
# reimplementation — it is the same runtime the VPS uses: Node 22, mihomo, curl,
# and the published CLI. Everything is baked at build time; the running
# container never calls npm, because a mid-run install is both slow and a
# failure mode that only appears in production.
FROM node:22-bookworm-slim

ARG MIHOMO_VERSION=v1.19.34
ARG AUTOVPN_VERSION=2.2.4
# Build-time only. Cloudflare's builder has no route to GitHub from every
# region; pass the operator's proxy here when building locally for a push.
ARG HTTPS_PROXY
ARG HTTP_PROXY

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=8080 \
    VPN_AUTOMATION_RUNTIME_ROOT=/data/auto-vpn \
    AUTOVPN_PROJECT_ROOT=/opt/autovpn \
    AUTOVPN_CLI_ENTRY=/usr/local/lib/node_modules/@swimmingliu/autovpn/bin/autovpn.mjs \
    MIHOMO_BIN=/usr/local/bin/mihomo \
    EGRESS_DIR=/data/egress

# curl is the CLI's TLS fallback transport (egress.ts spawns it with
# --insecure when Node's fetch rejects a vendor's intercepted chain), ca-certificates
# is required for everything else, and tini reaps the mihomo children the
# measurement stages spawn per link.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tini tzdata \
 && rm -rf /var/lib/apt/lists/*

# mihomo: one binary, used both for per-link measurement (spawned by the CLI)
# and for the crawl egress pool (spawned by the supervisor).
#
# `vendor/mihomo-linux-amd64` is produced by `scripts/fetch-mihomo.sh` so the
# image can be built on a host whose Docker VM has no route to GitHub release
# objects (the redirect target is not reachable through every proxy). When the
# file is absent the build falls back to downloading, which is what CI does.
COPY vendor/ /tmp/vendor/

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    installed=0; \
    if [ "$arch" = "amd64" ] && [ -f /tmp/vendor/mihomo-linux-amd64 ]; then \
      install -m 0755 /tmp/vendor/mihomo-linux-amd64 /usr/local/bin/mihomo; \
      installed=1; \
    fi; \
    if [ "$installed" = "0" ]; then \
      case "$arch" in \
        amd64) mihomo_asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz" ;; \
        arm64) mihomo_asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz" ;; \
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
      esac; \
      curl -fsSL --retry 5 --retry-delay 3 \
        "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${mihomo_asset}" \
        -o /tmp/mihomo.gz; \
      gunzip -c /tmp/mihomo.gz > /usr/local/bin/mihomo; \
      chmod 0755 /usr/local/bin/mihomo; \
      rm -f /tmp/mihomo.gz; \
    fi; \
    rm -rf /tmp/vendor; \
    /usr/local/bin/mihomo -v

# The CLI, pinned. `--ignore-scripts` keeps the install from reaching for a
# network the build may not have; the package ships prebuilt JS.
RUN npm install -g --no-audit --no-fund --ignore-scripts "@swimmingliu/autovpn@${AUTOVPN_VERSION}" \
 && node "$AUTOVPN_CLI_ENTRY" --version

# The project tree the pipeline reads. Only the worker template is actually
# consulted (`resolveWorkerTemplatePath` checks `<projectRoot>/templates` before
# falling back to the packaged copy), but the directory has to exist and carry
# the package marker `resolveRuntimeRoot` walks up looking for.
RUN mkdir -p /opt/autovpn/templates \
 && cp /usr/local/lib/node_modules/@swimmingliu/autovpn/dist/templates/vmess_node.js /opt/autovpn/templates/vmess_node.js \
 && printf '{"name":"vpn-subscription-automation","private":true}\n' > /opt/autovpn/package.json

# The container's own HTTP skin, egress supervisor, and the profile template.
# The template carries no credentials; the Worker secret overwrites it at boot.
COPY src/ /opt/container/
COPY profile.cloudflare.toml /opt/container/profile.cloudflare.toml

RUN mkdir -p /data/auto-vpn /data/egress /data/auto-vpn/artifacts /data/auto-vpn/tools \
 && cp /opt/container/profile.cloudflare.toml /data/auto-vpn/profile.toml \
 && chmod 0600 /data/auto-vpn/profile.toml

EXPOSE 8080

# tini as PID 1: the CLI spawns one mihomo per measured link, and a leaked
# zombie handles would eventually exhaust the container's PID table.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/container/server.mjs"]
