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

  // A track just got removed from a playlist somewhere - drop it from
  // every live session's queue (and skip it if it's the one currently
  // playing), in every guild, not just the one the removal happened in.
  evictTrackEverywhere(trackId) {
    for (const session of this.sessions.values()) session.evictTrack(trackId);
  }
}

export const audioManager = new AudioManager();
