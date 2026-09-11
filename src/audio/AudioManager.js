import { AudioSession } from './AudioSession.js';
import { attachSessionUI } from '../utils/attachSessionUI.js';

// One AudioSession per guild. This map is the single source of truth for
// "is this guild currently playing", and nothing here ever reaches across
// guild boundaries - each guild's session owns its own connection, player,
// volume and history independently of every other guild.
class AudioManager {
  constructor() {
    this.sessions = new Map();
  }

  get(guildId) {
    return this.sessions.get(guildId) ?? null;
  }

  has(guildId) {
    return this.sessions.has(guildId);
  }

  // The only place a session is constructed, so attachSessionUI is
  // guaranteed to run exactly once per session even across repeated calls.
  getOrCreate({ guild, voiceChannel, textChannel }) {
    let session = this.sessions.get(guild.id);
    if (session) return session;

    session = new AudioSession({ guild, voiceChannel, textChannel });
    session.once('destroyed', () => this.sessions.delete(guild.id));
    attachSessionUI(session);
    this.sessions.set(guild.id, session);
    return session;
  }

  destroy(guildId, reason) {
    const session = this.sessions.get(guildId);
    session?.destroy(reason);
  }

  destroyAll(reason) {
    for (const session of this.sessions.values()) session.destroy(reason);
  }
}

export const audioManager = new AudioManager();
