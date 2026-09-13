import { db } from './db.js';

const addSecondsStmt = db.prepare(`
  INSERT INTO listening_stats (guild_id, user_id, seconds_listened, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    seconds_listened = seconds_listened + excluded.seconds_listened,
    updated_at = CURRENT_TIMESTAMP
`);
const getTopStmt = db.prepare(`
  SELECT user_id, seconds_listened FROM listening_stats
  WHERE guild_id = ? ORDER BY seconds_listened DESC LIMIT ?
`);

export const ListeningStatsRepo = {
  addSeconds(guildId, userId, seconds) {
    addSecondsStmt.run(guildId, userId, seconds);
  },
  getTop(guildId, limit = 10) {
    return getTopStmt.all(guildId, limit);
  },
};
