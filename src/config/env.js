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
};
