import { MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { trackAnnouncementEmbed, queueEmbed } from '../utils/embeds.js';
import { playerControlRows, queueShuffleRow } from '../utils/controls.js';
import { stopHype } from '../audio/hypeControl.js';
import { voteManager } from '../voting/VoteManager.js';
import { removeTrackFromPlaylist, restoreTrackToPlaylist } from '../library/playlistOps.js';

const VOLUME_STEP = 10;

export async function handleButton(interaction) {
  const [namespace] = interaction.customId.split(':');

  if (namespace === 'ctrl') return handleControlButton(interaction);
  if (namespace === 'vote') return handleVoteButton(interaction);
  if (namespace === 'track') return handleTrackButton(interaction);
  if (namespace === 'queue') return handleQueueButton(interaction);

  return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
}

async function handleControlButton(interaction) {
  const [, action] = interaction.customId.split(':');

  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  const { session } = active;

  if (action === 'prev') {
    const moved = session.previous();
    if (!moved) {
      return interaction.reply({ content: 'ℹ️ Дальше назад в истории ничего нет.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
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
    return interaction.reply({ content: '⏹️ Хайповый музон выключен.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
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

  return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
}

async function handleVoteButton(interaction) {
  const [, kind] = interaction.customId.split(':');
  const result = await voteManager.castVote(interaction.guild.id, kind, interaction.member);
  return interaction.reply({
    content: result.ok ? '✅ Голос засчитан!' : result.message,
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
  });
}

async function handleTrackButton(interaction) {
  const [, action, rawPlaylistId, rawTrackId] = interaction.customId.split(':');
  const playlistId = Number.parseInt(rawPlaylistId, 10);
  const trackId = Number.parseInt(rawTrackId, 10);

  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  if (action === 'unlink') {
    const result = removeTrackFromPlaylist(playlistId, trackId);
    const note = result.hardDeleted ? ' (файл удалён, т.к. это был последний плейлист с этим треком)' : '';
    return interaction.update({ content: `↩️ Добавление отменено.${note}`, embeds: [], components: [] });
  }

  if (action === 'relink') {
    const result = restoreTrackToPlaylist(playlistId, trackId);
    if (!result.ok) {
      return interaction.reply({ content: '❌ Трек больше не существует, восстановить нельзя.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
    }
    return interaction.update({ content: '♻️ Трек восстановлен в плейлисте.', embeds: [], components: [] });
  }

  return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
}

async function handleQueueButton(interaction) {
  const [, action] = interaction.customId.split(':');
  if (action !== 'shuffle') {
    return interaction.reply({ content: '❌ Неизвестное действие.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }

  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  active.session.reshuffleQueue();
  return interaction.update({ embeds: [queueEmbed(active.session)], components: queueShuffleRow() });
}
