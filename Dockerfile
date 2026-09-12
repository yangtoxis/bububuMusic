FROM node:20-bookworm-slim

# Build toolchain for @discordjs/opus (native addon, no prebuilt binary for
# every Node/glibc combo). ffmpeg comes from apt, NOT the ffmpeg-static npm
# package - that binary is statically linked against glibc and segfaults on
# getaddrinfo() inside containers (see project skill notes). yt-dlp is
# installed via pip rather than apt so the library import pipeline gets a
# recent, actively-maintained extractor instead of Debian's stale package.
# curl is used (instead of Node's own fetch) for scraping Spotify/Yandex
# Music/SoundCloud page metadata - some of these services fingerprint and
# block Node's undici TLS handshake specifically while passing curl's
# through unblocked from the very same IP (observed in production against
# Yandex Music - identical request, identical host, 403 from fetch() vs 200
# from curl).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl python3 python3-pip make g++ pkg-config libopus-dev ffmpeg && \
    pip install --no-cache-dir --break-system-packages yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
