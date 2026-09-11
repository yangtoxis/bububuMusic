import { db } from './db.js';
import { env } from '../config/env.js';

const upsertStmt = db.prepare(`
  INSERT INTO guild_settings (guild_id, volume, vote_start_percent, vote_stop_percent)
  VALUES (@guild_id, @volume, @vote_start_percent, @vote_stop_percent)
  ON CONFLICT(guild_id) DO NOTHING
`);
const getStmt = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
const setVolumeStmt = db.prepare(
  "UPDATE guild_settings SET volume = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?"
);
const setVoteStartPercentStmt = db.prepare(
  "UPDATE guild_settings SET vote_start_percent = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?"
);
const setVoteStopPercentStmt = db.prepare(
  "UPDATE guild_settings SET vote_stop_percent = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?"
);

function ensure(guildId) {
  upsertStmt.run({
    guild_id: guildId,
    volume: env.defaultVolume,
    vote_start_percent: env.defaultVoteStartPercent,
    vote_stop_percent: env.defaultVoteStopPercent,
  });
}

export const GuildSettingsRepo = {
  get(guildId) {
    ensure(guildId);
    return getStmt.get(guildId);
  },
  setVolume(guildId, volume) {
    ensure(guildId);
    setVolumeStmt.run(volume, guildId);
  },
  setVoteStartPercent(guildId, percent) {
    ensure(guildId);
    setVoteStartPercentStmt.run(percent, guildId);
  },
  setVoteStopPercent(guildId, percent) {
    ensure(guildId);
    setVoteStopPercentStmt.run(percent, guildId);
  },
};
