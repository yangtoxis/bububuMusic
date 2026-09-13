import { EventEmitter } from 'node:events';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import fs from 'node:fs';
import { LocalFileSource } from '../sources/LocalFileSource.js';
import { pickNextTrack, normalizeArtist } from '../library/TrackSelector.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { GuildSettingsRepo } from '../database/GuildSettingsRepo.js';
import { recordPlay, getRecentlyPlayed } from './recentlyPlayed.js';
import { ListeningStatsRepo } from '../database/ListeningStatsRepo.js';
import { createLogger } from '../utils/logger.js';

export const QUEUE_LOOKAHEAD = 5;
const HISTORY_SIZE = 8;
const RECENT_ARTIST_WINDOW = 2;
const MAX_CONSECUTIVE_FAILURES = 5;
const PLAYED_STACK_SIZE = 20;
const LISTENING_TICK_MS = 60_000;

export class AudioSession extends EventEmitter {
  constructor({ guild, voiceChannel, textChannel }) {
    super();
    this.guild = guild;
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;

    this.mode = 'hype'; // 'hype' | 'mix' - set for real in start(mode)
    this.currentTrack = null;
    this.currentTrackPlaylistId = null; // which playlist the current track was drawn from
    this.trackStartedAt = null;
    this.upcoming = []; // materialized queue of the next tracks, always kept topped up
    this.playedStack = []; // full track objects, most-recent last - powers "previous"
    // Seeded from what actually played last time this guild had a session,
    // so a fresh /play right after /stop doesn't immediately replay it.
    this._history = getRecentlyPlayed(guild.id).slice(); // most recent first: { id, artist }
    this._consecutiveFailures = 0;
    this._destroyed = false;
    this._source = null;
    this._mixRotationIndex = 0;

    this.volume = GuildSettingsRepo.get(guild.id).volume;

    this.logger = createLogger({ module: 'AudioSession', guildId: guild.id });

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.connection.subscribe(this.player);

    this._listeningInterval = setInterval(() => this._tickListening(), LISTENING_TICK_MS);

    this._wireConnection();
    this._wirePlayer();
  }

  _wireConnection() {
    this.connection.on('stateChange', (oldState, newState) => {
      this.logger.debug('voice connection stateChange', { from: oldState.status, to: newState.status });
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this._destroyed) this.destroy('voice_disconnected');
      }
    });

    this.connection.on('error', (err) => {
      this.logger.error('voice connection error', { error: err.message });
    });
  }

  _wirePlayer() {
    this.player.on(AudioPlayerStatus.Playing, () => {
      this._consecutiveFailures = 0;
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this._destroyed) return;
      this._advance().catch((err) => this.logger.error('advance failed', { error: err.message }));
    });

    this.player.on('error', (err) => {
      this.logger.warn('audio player error', { error: err.message, trackId: this.currentTrack?.id });
      if (this._destroyed) return;
      this._consecutiveFailures += 1;
      this.emit('trackError', { track: this.currentTrack, reason: err.message });
      this._advance().catch((e) => this.logger.error('advance after error failed', { error: e.message }));
    });
  }

  async start(mode = 'hype') {
    this.mode = mode;
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this._fillQueue();
    await this._advance();
  }

  // Who the "Микс" rotation currently draws from: the shared library
  // playlist, plus every non-bot member in the channel who has tracks in
  // their own personal playlist. Recomputed on demand (not cached) so
  // someone joining/leaving mid-session is reflected in future picks
  // without any extra event wiring.
  _computeMixSources() {
    const library = PlaylistRepo.getOrCreateLibrary();
    const sources = [{ playlistId: library.id, label: '🔥 Хайповый музон' }];

    for (const member of this.voiceChannel.members.values()) {
      if (member.user.bot) continue;
      const personal = PlaylistRepo.getPersonal(member.id);
      if (!personal) continue;
      if (PlaylistRepo.countReady(personal.id) === 0) continue;
      sources.push({ playlistId: personal.id, label: `🎧 ${member.displayName}` });
    }

    return sources;
  }

  // Guild-facing summary of who's currently in the mix rotation, for the
  // /play confirmation message.
  getMixSourceLabels() {
    return this._computeMixSources().map((s) => s.label);
  }

  _fillQueue() {
    if (this.mode === 'mix') this._fillQueueMix();
    else this._fillQueueHype();
  }

  _fillQueueHype() {
    const library = PlaylistRepo.getOrCreateLibrary();
    while (this.upcoming.length < QUEUE_LOOKAHEAD) {
      const pick = pickNextTrack({
        playlistId: library.id,
        excludeTrackIds: this._buildExcludeIds(),
        recentArtists: this._buildRecentArtists(),
      });
      if (!pick) break; // library empty or exhausted
      pick._sourcePlaylistId = library.id;
      pick._sourceLabel = '🔥 Хайповый музон';
      this.upcoming.push(pick);
    }
  }

  // Round-robins through the library + everyone's personal playlist for
  // each new slot. The global exclude/recent-artist sets (spanning history
  // + whatever's already queued, regardless of which playlist it came
  // from) are what keep the *same track* from repeating even when it
  // happens to sit in two different people's playlists at once.
  _fillQueueMix() {
    const sources = this._computeMixSources();
    if (sources.length === 0) return;

    let consecutiveMisses = 0;
    while (this.upcoming.length < QUEUE_LOOKAHEAD && consecutiveMisses < sources.length) {
      const source = sources[this._mixRotationIndex % sources.length];
      this._mixRotationIndex += 1;

      const pick = pickNextTrack({
        playlistId: source.playlistId,
        excludeTrackIds: this._buildExcludeIds(),
        recentArtists: this._buildRecentArtists(),
      });
      if (!pick) {
        consecutiveMisses += 1;
        continue;
      }
      consecutiveMisses = 0;
      pick._sourcePlaylistId = source.playlistId;
      pick._sourceLabel = source.label;
      this.upcoming.push(pick);
    }
  }

  // Exclude the last few actually-played tracks (persists across a
  // /stop + /play cycle, see recentlyPlayed.js) plus whatever's already
  // queued. Ordered with the most immediate one (currentTrack) last -
  // pickNextTrack's small-playlist fallback relaxes older exclusions first
  // and keeps protecting the most recent one the longest.
  _buildExcludeIds() {
    const historyIds = this._history.map((h) => h.id);
    return [...historyIds, ...this.upcoming.map((t) => t.id), this.currentTrack?.id].filter(Boolean);
  }

  // Only look at the artist(s) immediately preceding the slot being filled
  // - either the tail of what's already queued, or actual play history if
  // the queue is still empty. Using the *whole* queue built so far instead
  // of just its tail self-defeats once every artist in a small playlist is
  // already represented in it (the filter would exclude everything and
  // fall back to no filter at all, right at the position most likely to
  // land a same-artist repeat).
  _buildRecentArtists() {
    return this.upcoming.length > 0
      ? this.upcoming.slice(-RECENT_ARTIST_WINDOW).map((t) => normalizeArtist(t.artist))
      : this._history.slice(0, RECENT_ARTIST_WINDOW).map((h) => h.artist);
  }

  async _advance() {
    if (this._destroyed) return;

    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.emit('error', 'Слишком много треков подряд не удалось воспроизвести. Останавливаюсь.');
      this.destroy('too_many_failures');
      return;
    }

    if (this.upcoming.length === 0) this._fillQueue();
    const next = this.upcoming.shift();

    if (!next) {
      this.currentTrack = null;
      this.emit('empty');
      this.destroy('library_empty');
      return;
    }

    if (!next.file_path || !fs.existsSync(next.file_path)) {
      this.logger.warn('track file missing on disk, skipping', { trackId: next.id, filePath: next.file_path });
      this._consecutiveFailures += 1;
      this._recordHistory(next);
      await this._advance();
      return;
    }

    this._playTrack(next);
    this._fillQueue(); // top the queue back up, now correctly excluding the new currentTrack
  }

  _playTrack(track, { pushPrevious = true } = {}) {
    if (this._source) this._source.destroy();

    if (pushPrevious && this.currentTrack) {
      this.playedStack.push(this.currentTrack);
      if (this.playedStack.length > PLAYED_STACK_SIZE) this.playedStack.shift();
    }

    this.currentTrack = track;
    this.currentTrackPlaylistId = track._sourcePlaylistId ?? null;
    this.trackStartedAt = Date.now();
    this._recordHistory(track);

    this._source = new LocalFileSource(track);
    const stream = this._source.createStream();
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume?.setVolume(this.volume / 100);
    this._resource = resource;

    this.player.play(resource);
    this.emit('trackChange', track);
  }

  _recordHistory(track) {
    this._history.unshift({ id: track.id, artist: normalizeArtist(track.artist) });
    if (this._history.length > HISTORY_SIZE) this._history.length = HISTORY_SIZE;
    recordPlay(this.guild.id, track);
  }

  skip() {
    if (this._destroyed) return;
    // Idle handler advances into the already-materialized queue, so the
    // track that just stopped can't be immediately reselected.
    this.player.stop(true);
  }

  // A track was just removed from the playlist it was drawn from (anywhere
  // - not necessarily this guild). Drop it from the upcoming queue if it's
  // sitting there, and skip past it immediately if it's currently playing.
  evictTrack(trackId) {
    if (this._destroyed) return;

    const wasQueued = this.upcoming.some((t) => t.id === trackId);
    if (wasQueued) {
      this.upcoming = this.upcoming.filter((t) => t.id !== trackId);
      this._fillQueue();
    }

    if (this.currentTrack?.id === trackId) {
      this.skip();
    }
  }

  previous() {
    if (this._destroyed) return false;
    const prevTrack = this.playedStack.pop();
    if (!prevTrack) return false;

    // Put the current track back at the front of the queue so pressing
    // "next" again returns to where we were, instead of losing it.
    if (this.currentTrack) this.upcoming.unshift(this.currentTrack);
    this._playTrack(prevTrack, { pushPrevious: false });
    this._fillQueue();
    return true;
  }

  pause() {
    if (this._destroyed) return;
    this.player.pause();
  }

  resume() {
    if (this._destroyed) return;
    this.player.unpause();
  }

  get isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  reshuffleQueue() {
    this.upcoming = [];
    this._fillQueue();
  }

  addToQueueFront(track) {
    this.upcoming.unshift(track);
  }

  getUpcoming(limit = QUEUE_LOOKAHEAD) {
    return this.upcoming.slice(0, limit);
  }

  setVolume(percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    this.volume = clamped;
    this._resource?.volume?.setVolume(clamped / 100);
    GuildSettingsRepo.setVolume(this.guild.id, clamped);
    return clamped;
  }

  getProgressSeconds() {
    if (!this.trackStartedAt) return 0;
    return Math.floor((Date.now() - this.trackStartedAt) / 1000);
  }

  // Credits every non-bot member currently in the channel with one tick of
  // listening time - only while an actual track is playing (not paused),
  // so a stalled reconnect or a silent empty session doesn't rack up time.
  _tickListening() {
    if (this._destroyed || !this.currentTrack || this.isPaused) return;
    const seconds = LISTENING_TICK_MS / 1000;
    for (const member of this.voiceChannel.members.values()) {
      if (member.user.bot) continue;
      ListeningStatsRepo.addSeconds(this.guild.id, member.id, seconds);
    }
  }

  destroy(reason = 'manual') {
    if (this._destroyed) return;
    this._destroyed = true;
    this.logger.info('destroying session', { reason });

    clearInterval(this._listeningInterval);
    if (this._source) this._source.destroy();
    try {
      this.player.stop(true);
    } catch {
      /* already stopped */
    }
    try {
      this.connection.destroy();
    } catch {
      /* already destroyed */
    }
    this.emit('destroyed', reason);
    this.removeAllListeners();
  }
}
