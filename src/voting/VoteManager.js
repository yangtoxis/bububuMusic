import { MessageFlags } from 'discord.js';
import { GuildSettingsRepo } from '../database/GuildSettingsRepo.js';
import { isDjInVoiceChannel } from '../utils/djGuard.js';
import { voteEmbed } from '../utils/embeds.js';
import { voteRow } from '../utils/controls.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'VoteManager' });
const TICK_MS = 15_000;

function nonBotMemberCount(voiceChannel) {
  if (!voiceChannel) return 0;
  return voiceChannel.members.filter((m) => !m.user.bot).size;
}

function computeNeeded(voiceChannel, percent) {
  const count = nonBotMemberCount(voiceChannel);
  return Math.max(1, Math.ceil((percent / 100) * count));
}

class VoteManager {
  constructor() {
    this._votes = new Map(); // `${guildId}:${kind}` -> state
  }

  _key(guildId, kind) {
    return `${guildId}:${kind}`;
  }

  get(guildId, kind) {
    return this._votes.get(this._key(guildId, kind));
  }

  hasActive(guildId, kind) {
    return this._votes.has(this._key(guildId, kind));
  }

  /**
   * @param onThresholdReached async () => void - runs when the vote passes
   */
  async start({ guild, kind, starter, voiceChannel, textChannel, onThresholdReached }) {
    const key = this._key(guild.id, kind);
    if (this._votes.has(key)) {
      return { ok: false, message: 'Голосование уже запущено. Присоединяйся к нему кнопкой в сообщении выше.' };
    }

    const settings = GuildSettingsRepo.get(guild.id);
    const percent = kind === 'start' ? settings.vote_start_percent : settings.vote_stop_percent;
    const expiresAt = Date.now() + env.voteTimeoutSeconds * 1000;

    const state = {
      guildId: guild.id,
      kind,
      starterTag: starter.tag ?? starter.username,
      voiceChannelId: voiceChannel.id,
      textChannel,
      percent,
      votes: new Set([starter.id]),
      message: null,
      timer: null,
      tickInterval: null,
      expiresAt,
      onThresholdReached,
      finished: false,
    };
    this._votes.set(key, state);

    const message = await textChannel.send({
      embeds: [this._buildEmbed(guild, state)],
      components: voteRow(kind),
      flags: MessageFlags.SuppressNotifications,
    });
    state.message = message;

    state.timer = setTimeout(() => this._expire(key), env.voteTimeoutSeconds * 1000);
    state.tickInterval = setInterval(() => this._refresh(key), TICK_MS);

    const passed = await this._checkThreshold(key);
    return { ok: true, passed };
  }

  async castVote(guildId, kind, member) {
    const key = this._key(guildId, kind);
    const state = this._votes.get(key);
    if (!state) return { ok: false, message: '❌ Активного голосования нет.' };

    if (member.voice.channel?.id !== state.voiceChannelId) {
      return { ok: false, message: '❌ Голосовать может только тот, кто находится в этом голосовом канале.' };
    }
    if (state.votes.has(member.id)) {
      return { ok: false, message: 'Ты уже проголосовал(а).' };
    }

    state.votes.add(member.id);
    await this._refresh(key);
    const passed = await this._checkThreshold(key);
    return { ok: true, passed };
  }

  // Called from the global voiceStateUpdate listener for every active vote.
  async handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild.id;
    for (const kind of ['start', 'stop']) {
      const key = this._key(guildId, kind);
      const state = this._votes.get(key);
      if (!state || state.finished) continue;

      const userId = newState.id;
      const wasInChannel = oldState.channelId === state.voiceChannelId;
      const nowInChannel = newState.channelId === state.voiceChannelId;

      if (wasInChannel && !nowInChannel && state.votes.has(userId)) {
        state.votes.delete(userId);
      }

      // A DJ appearing in the channel makes a vote-start unnecessary AND is
      // the exact bypass this system must not allow: a running vote must
      // not let regular users reach the threshold once a DJ can just do it
      // directly. Cancel rather than silently keep counting.
      if (kind === 'start' && !wasInChannel && nowInChannel) {
        const voiceChannel = newState.guild.channels.cache.get(state.voiceChannelId);
        if (isDjInVoiceChannel(voiceChannel)) {
          await this._cancel(key, '❌ Голосование отменено: в канал зашёл DJ. Используй `/play`, чтобы включить музыку напрямую.');
          continue;
        }
      }

      if (wasInChannel !== nowInChannel) {
        const passed = await this._checkThreshold(key);
        if (!passed) await this._refresh(key);
      }
    }
  }

  async _checkThreshold(key) {
    const state = this._votes.get(key);
    if (!state || state.finished) return false;

    const guild = state.textChannel.guild;
    const voiceChannel = guild.channels.cache.get(state.voiceChannelId);
    const needed = computeNeeded(voiceChannel, state.percent);

    if (state.votes.size >= needed) {
      state.finished = true;
      this._teardownTimers(state);
      this._votes.delete(key);
      try {
        await state.message.edit({
          embeds: [this._buildEmbed(guild, state, { finishedLabel: '✅ Голосование прошло успешно!' })],
          components: [],
        });
      } catch {
        /* message may be gone */
      }
      try {
        await state.onThresholdReached?.();
      } catch (err) {
        logger.error('onThresholdReached failed', { error: err.message, kind: state.kind });
      }
      return true;
    }
    return false;
  }

  async _refresh(key) {
    const state = this._votes.get(key);
    if (!state || state.finished) return;
    const guild = state.textChannel.guild;
    try {
      await state.message.edit({ embeds: [this._buildEmbed(guild, state)], components: voteRow(state.kind) });
    } catch (err) {
      logger.warn('failed to refresh vote message', { error: err.message });
    }
  }

  async _expire(key) {
    const state = this._votes.get(key);
    if (!state || state.finished) return;
    state.finished = true;
    this._teardownTimers(state);
    this._votes.delete(key);
    try {
      await state.message.edit({
        embeds: [this._buildEmbed(state.textChannel.guild, state, { finishedLabel: '⌛ Время вышло. Голосование отменено.' })],
        components: [],
      });
    } catch {
      /* message may be gone */
    }
  }

  async _cancel(key, reason) {
    const state = this._votes.get(key);
    if (!state || state.finished) return;
    state.finished = true;
    this._teardownTimers(state);
    this._votes.delete(key);
    try {
      await state.message.edit({
        embeds: [this._buildEmbed(state.textChannel.guild, state, { finishedLabel: reason })],
        components: [],
      });
    } catch {
      /* message may be gone */
    }
  }

  _teardownTimers(state) {
    clearTimeout(state.timer);
    clearInterval(state.tickInterval);
  }

  _buildEmbed(guild, state, { finishedLabel } = {}) {
    const voiceChannel = guild.channels.cache.get(state.voiceChannelId);
    const needed = computeNeeded(voiceChannel, state.percent);
    const secondsLeft = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
    const embed = voteEmbed({
      kind: state.kind,
      starterTag: state.starterTag,
      votes: state.votes.size,
      needed,
      secondsLeft,
      channelId: state.voiceChannelId,
    });
    if (finishedLabel) embed.setFooter({ text: finishedLabel });
    return embed;
  }
}

export const voteManager = new VoteManager();
