import { db } from './db.js';

const insertStmt = db.prepare(`
  INSERT INTO import_jobs (guild_id, requested_by, filename, total_lines, status, channel_id)
  VALUES (@guild_id, @requested_by, @filename, @total_lines, 'queued', @channel_id)
`);
const getStmt = db.prepare('SELECT * FROM import_jobs WHERE id = ?');
const updateProgressStmt = db.prepare(`
  UPDATE import_jobs SET processed = ?, added = ?, existing = ?, failed = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);
const setStatusStmt = db.prepare(
  "UPDATE import_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
);
const setMessageStmt = db.prepare('UPDATE import_jobs SET message_id = ? WHERE id = ?');
const setFailedItemsStmt = db.prepare('UPDATE import_jobs SET failed_items = ? WHERE id = ?');

export const ImportJobRepo = {
  create({ guildId, requestedBy, filename, totalLines, channelId }) {
    const result = insertStmt.run({
      guild_id: guildId,
      requested_by: requestedBy,
      filename,
      total_lines: totalLines,
      channel_id: channelId,
    });
    return getStmt.get(result.lastInsertRowid);
  },
  get(id) {
    return getStmt.get(id);
  },
  updateProgress(id, { processed, added, existing, failed }) {
    updateProgressStmt.run(processed, added, existing, failed, id);
  },
  setStatus(id, status) {
    setStatusStmt.run(status, id);
  },
  setMessageId(id, messageId) {
    setMessageStmt.run(messageId, id);
  },
  setFailedItems(id, items) {
    setFailedItemsStmt.run(JSON.stringify(items), id);
  },
};
