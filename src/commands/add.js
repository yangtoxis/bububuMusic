import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { resolveTrackRequest, UnresolvableError } from '../library/TrackResolver.js';
import { detectPlaylistUrl } from '../library/PlaylistUrlResolver.js';
import { runPlaylistUrlImport } from '../library/bulkImportFlow.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { audioManager } from '../audio/AudioManager.js';
import { trackAddedEmbed } from '../utils/embeds.js';
import { undoAddRow } from '../utils/controls.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'add' });

export const data = new SlashCommandBuilder()
  .setName('add')
  .setDescription('Добавить трек(и) в библиотеку «Хайповый музон» (только DJ)')
  .addStringOption((opt) =>
    opt
      .setName('track')
      .setDescription('Название, ссылка на трек, или ссылка на плейлист/альбом (YouTube/Spotify/Яндекс/SoundCloud)')
      .setRequired(true)
  );

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  const trackQuery = interaction.options.getString('track', true);
  const library = PlaylistRepo.getOrCreateLibrary();

  const playlistUrl = detectPlaylistUrl(trackQuery);
  if (playlistUrl) {
    return runPlaylistUrlImport(interaction, playlistUrl, library.id);
  }

  await interaction.deferReply({ flags: MessageFlags.SuppressNotifications });

  let result;
  try {
    result = await resolveTrackRequest(trackQuery, { addedBy: interaction.user.id, playlistId: library.id });
  } catch (err) {
    if (err instanceof UnresolvableError) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    logger.error('single track add failed', { error: err.message, query: trackQuery });
    return interaction.editReply({ content: `❌ Не удалось добавить трек: ${err.message}` });
  }

  // A track added straight to the library is what the DJ presumably wants
  // to hear next, not whenever shuffle happens to draw it - so if there's
  // a live session in this guild, jump it to the front of the queue.
  const session = audioManager.get(interaction.guild.id);
  if (session) session.addToQueueFront(result.track);

  const embed = trackAddedEmbed(result.track, { alreadyInPlaylist: result.alreadyInPlaylist });
  const components = result.alreadyInPlaylist ? [] : undoAddRow(library.id, result.track.id);
  return interaction.editReply({ embeds: [embed], components });
}
