import fs from 'node:fs';
import { MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { trackAnnouncementEmbed, queueEmbed } from '../utils/embeds.js';
import { playerControlRows, queueShuffleRow } from '../utils/controls.js';
import { stopHype } from '../audio/hypeControl.js';
import { voteManager } from '../voting/VoteManager.js';
import { TrackRepo } from '../database/TrackRepo.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'buttonHandler' });
const VOLUME_STEP = 10;

export async function handleButton(interaction) {
  const [namespace] = interaction.customId.split(':');

  if (namespace === 'ctrl') return handleControlButton(interaction);
  if (namespace === 'vote') return handleVoteButton(interaction);
  if (namespace === 'track') return handleTrackButton(interaction);
  if (namespace === 'queue') return handleQueueButton(interaction);

  return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral });
}

async function handleControlButton(interaction) {
  const [, action] = interaction.customId.split(':');

  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });
  const { session } = active;

  if (action === 'prev') {
    const moved = session.previous();
    if (!moved) {
      return interaction.reply({ content: 'ℹ️ Дальше назад в истории ничего нет.', flags: MessageFlags.Ephemeral });
    }
    // The resulting trackChange event reposts the whole message on its own.
    return interaction.deferUpdate();
  }

  if (action === 'next') {
    session.skip();
    return interaction.deferUpdate();
  }

  if (action === 'stop') {
    stopHype(interaction.guild.id, 'panel_stop');
    return interaction.reply({ content: '⏹️ Хайповый музон выключен.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'playpause') {
    if (session.isPaused) session.resume();
    else session.pause();
    return interaction.update({ embeds: [trackAnnouncementEmbed(session)], components: playerControlRows(session) });
  }

  if (action === 'voldown' || action === 'volup') {
    const delta = action === 'volup' ? VOLUME_STEP : -VOLUME_STEP;
    session.setVolume(session.volume + delta);
    return interaction.update({ embeds: [trackAnnouncementEmbed(session)], components: playerControlRows(session) });
  }

  return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral });
}

async function handleVoteButton(interaction) {
  const [, kind] = interaction.customId.split(':');
  const result = await voteManager.castVote(interaction.guild.id, kind, interaction.member);
  return interaction.reply({
    content: result.ok ? '✅ Голос засчитан!' : result.message,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTrackButton(interaction) {
  const [, action, rawId] = interaction.customId.split(':');
  const trackId = Number.parseInt(rawId, 10);

  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  if (action === 'undo-add') {
    const track = TrackRepo.getById(trackId);
    if (!track) return interaction.reply({ content: 'ℹ️ Этот трек уже удалён.', flags: MessageFlags.Ephemeral });

    TrackRepo.deleteById(trackId);
    if (track.file_path) {
      fs.promises.unlink(track.file_path).catch((err) => {
        if (err.code !== 'ENOENT') logger.warn('failed to unlink undone track file', { error: err.message });
      });
    }
    return interaction.update({ content: `↩️ Добавление отменено, трек удалён.`, embeds: [], components: [] });
  }

  if (action === 'undo-remove') {
    TrackRepo.restore(trackId);
    return interaction.update({ content: '♻️ Трек восстановлен в библиотеке.', embeds: [], components: [] });
  }

  return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral });
}

async function handleQueueButton(interaction) {
  const [, action] = interaction.customId.split(':');
  if (action !== 'shuffle') {
    return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral });
  }

  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  active.session.reshuffleQueue();
  return interaction.update({ embeds: [queueEmbed(active.session)], components: queueShuffleRow() });
}
