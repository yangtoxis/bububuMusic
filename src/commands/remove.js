import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { removeTrackFromPlaylist } from '../library/playlistOps.js';
import { trackRemovedEmbed } from '../utils/embeds.js';
import { undoRemoveRow } from '../utils/controls.js';

export const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('Удалить играющий сейчас трек из плейлиста, из которого он играет, и пропустить его (только DJ)');

async function describePlaylist(guild, playlistId) {
  const playlist = PlaylistRepo.getById(playlistId);
  if (!playlist || playlist.kind === 'library') return 'библиотеки «Хайповый музон»';
  try {
    const member = await guild.members.fetch(playlist.owner_id);
    return `плейлиста ${member.displayName}`;
  } catch {
    return 'личного плейлиста';
  }
}

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  const track = active.session.currentTrack;
  if (!track) return interaction.reply({ content: '❌ Сейчас ничего не играет.', flags: MessageFlags.Ephemeral });

  const playlistId = active.session.currentTrackPlaylistId;
  if (!playlistId) {
    return interaction.reply({
      content: 'ℹ️ Этот трек добавлен вручную (`/add-queue`) и не привязан ни к одному плейлисту — используй `/skip`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const playlistLabel = await describePlaylist(interaction.guild, playlistId);
  // removeTrackFromPlaylist evicts the track from every live session,
  // including this one - it skips past it automatically since it's the
  // one currently playing.
  const result = removeTrackFromPlaylist(playlistId, track.id);

  return interaction.reply({
    embeds: [trackRemovedEmbed(track, { playlistLabel })],
    components: result.hardDeleted ? [] : undoRemoveRow(playlistId, track.id),
  });
}
