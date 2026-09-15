import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) {
    // Failing fast on missing secrets beats a confusing runtime error later.
    throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const env = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: process.env.GUILD_ID || null,

  dbPath: path.resolve(process.env.DB_PATH || './data/bot.sqlite'),
  libraryDir: path.resolve(process.env.LIBRARY_DIR || './data/library'),
  importsDir: path.resolve(process.env.IMPORTS_DIR || './data/imports'),

  defaultVolume: int('DEFAULT_VOLUME', 70),
  defaultVoteStartPercent: int('DEFAULT_VOTE_START_PERCENT', 50),
  defaultVoteStopPercent: int('DEFAULT_VOTE_STOP_PERCENT', 50),
  voteTimeoutSeconds: int('VOTE_TIMEOUT_SECONDS', 60),
  importTrackTimeoutSeconds: int('IMPORT_TRACK_TIMEOUT_SECONDS', 90),

  logLevel: process.env.LOG_LEVEL || 'info',

  // Optional. Authenticated requests to api.music.yandex.* are markedly
  // less likely to get anti-bot-flagged than anonymous ones - see
  // TrackResolver.js. Get one via the same OAuth flow the official Yandex
  // Music Android app uses (a well-known, widely-used technique - not a
  // security bypass, just logging in as yourself through a different
  // client_id): open
  //   https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d
  // while logged into the target account, approve, then copy the
  // "access_token" value out of the resulting music.yandex.ru/#access_token=...
  // redirect URL.
  yandexMusicToken: process.env.YANDEX_MUSIC_TOKEN || null,

  // Optional. A free app's Client Credentials (developer.spotify.com -> Create
  // app -> Web API) lets PlaylistUrlResolver.js pull full, paginated album
  // track lists via the real Spotify Web API. Note this does NOT help with
  // playlists specifically - Spotify locked playlist track reads behind real
  // user login in Feb 2026, so those still go through the embed-widget
  // fallback (capped under ~100 tracks) regardless of these being set.
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || null,
};
