import { db } from './db.js';

const addStmt = db.prepare('INSERT OR IGNORE INTO guild_dj_roles (guild_id, role_id) VALUES (?, ?)');
const removeStmt = db.prepare('DELETE FROM guild_dj_roles WHERE guild_id = ? AND role_id = ?');
const listStmt = db.prepare('SELECT role_id FROM guild_dj_roles WHERE guild_id = ?');

export const DjRoleRepo = {
  add(guildId, roleId) {
    addStmt.run(guildId, roleId);
  },
  remove(guildId, roleId) {
    removeStmt.run(guildId, roleId);
  },
  list(guildId) {
    return listStmt.all(guildId).map((r) => r.role_id);
  },
};
