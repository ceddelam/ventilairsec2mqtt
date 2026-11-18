# ventilairsec2mqtt Home Assistant app image.
#
# Build context: the repository root (CI: `docker build -f ventilairsec2mqtt/Dockerfile .`), or the
# self-contained folder made by `npm run app:local`, which holds the same files at the same paths
# and which the Supervisor builds as a local app. Only package*.json, tsconfig*.json and src/ are
# used (see .dockerignore).

# --- Build stage: compile the TypeScript sources, keep the production dependencies -------------
FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
# serialport's install script only looks for a prebuilt binding: nothing to run or compile.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && find dist node_modules \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' \) -delete \
    && find node_modules -type d -empty -delete \
    && find node_modules/@serialport/bindings-cpp/prebuilds -mindepth 1 -maxdepth 1 \
        ! -name linux-x64 ! -name linux-arm64 -exec rm -r {} + \
    && find node_modules/@serialport/bindings-cpp/prebuilds -name '*.node' ! -name '*musl*' -delete \
    && rm -rf node_modules/@serialport/bindings-cpp/src node_modules/@serialport/bindings-cpp/build

# --- App image ---------------------------------------------------------------------------------
FROM ghcr.io/home-assistant/base:3.24-2026.11.0

RUN apk add --no-cache nodejs

WORKDIR /app
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules/ node_modules/
COPY --from=build /build/dist/ dist/

ENV NODE_ENV=production

# Runs as the s6-overlay "main program": its exit code becomes the container's, and it gets
# SIGTERM when the app stops. with-contenv restores the container environment (SUPERVISOR_TOKEN,
# TZ), which s6-overlay clears for the main program.
CMD ["/command/with-contenv", "node", "/app/dist/main.js"]

LABEL \
    io.hass.type="app" \
    io.hass.name="ventilairsec2mqtt" \
    io.hass.description="Ventilairsec ventilation units (EnOcean radio) to MQTT and Home Assistant" \
    io.hass.url="https://github.com/ceddelam/ventilairsec2mqtt" \
    org.opencontainers.image.title="ventilairsec2mqtt" \
    org.opencontainers.image.description="Ventilairsec ventilation units (EnOcean radio) to MQTT and Home Assistant" \
    org.opencontainers.image.source="https://github.com/ceddelam/ventilairsec2mqtt" \
    org.opencontainers.image.licenses="MIT"
