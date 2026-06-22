# OpenHammer — multi-stage image (spec 16).
#
# Stages:
#   base  — node:22-bookworm-slim + the runtime binaries the tools presence-check
#           (`rg` for `grep`, `fd` for `find`). Debian names the fd binary `fdfind`;
#           it is symlinked to `fd` so `isToolAvailable("fd")` resolves — without
#           these, the in-container Tier-0 grep/find tests and the real server's
#           grep/find tools fail (spec 08 env note).
#   dev   — ALL deps (incl. tsx/vitest/biome); `npm test`/`typecheck`/`lint`, and
#           the compose `fixture-server` + `test-runner` services run `.ts` via tsx.
#           No build step — fixtures/tests run `.ts` directly.
#   build — `npm run build` → dist/ (consumed by prod).
#   prod  — production deps + built dist; `node dist/main.js` rooted at /data.
#
# `bookworm-slim` (not alpine) is deliberate: it makes the Debian `fd-find`/
# `ripgrep` packages and the `fdfind`→`fd` symlink from spec 08 apply verbatim.

# ── base: shared runtime binaries ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep fd-find ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s "$(command -v fdfind)" /usr/local/bin/fd

# ── dev: reproducible test/typecheck/lint env + compose fixture/runner ─────────
FROM base AS dev

WORKDIR /app

# Install ALL deps from the lockfile before copying source, so the dep layer
# caches across source-only changes. `npm ci` requires package-lock.json.
COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npm", "test"]

# ── build: compile TypeScript to dist/ ─────────────────────────────────────────
FROM dev AS build

RUN npm run build

# ── prod: slim runtime for the real OpenHammer server ──────────────────────────
FROM base AS prod

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
# Tool filesystem root. `loadConfig` resolves this and deliberately does not fail
# boot if it is absent, but we create it so the read/write/edit/bash tools have a
# writable root to operate under.
ENV MCP_ROOT_DIR=/data

# /data is the tool root (MCP_ROOT_DIR); make it writable by the non-root runtime
# user. The bundled `node` user's home (/home/node) is already node-writable, so
# `ensureToken` can mint ~/.openhammer/credential.json there — or set
# MCP_AUTH_TOKEN to skip the credential file entirely.
RUN mkdir -p /data && chown node:node /data

EXPOSE 3000

USER node

CMD ["node", "dist/main.js"]
