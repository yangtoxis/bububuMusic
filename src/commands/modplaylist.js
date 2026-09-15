import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireModerator } from '../utils/modGuard.js';
import { resolveTrackRequest, UnresolvableError } from '../library/TrackResolver.js';
import { detectPlaylistUrl } from '../library/PlaylistUrlResolver.js';
import { runBulkImport, runPlaylistUrlImport, looksLikeTextAttachment } from '../library/bulkImportFlow.js';
import { clearPlaylist } from '../library/playlistOps.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { trackAddedEmbed } from '../utils/embeds.js';
import { undoAddRow } from '../utils/controls.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'modplaylist' });

export const data = new SlashCommandBuilder()
  .setName('modplaylist')
  .setDescription('Управление личным плейлистом другого участника (только модераторы)')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Добавить трек или ссылку на плейлист в чей-то плейлист')
      .addUserOption((opt) => opt.setName('user').setDescription('Чей плейлист').setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName('track')
          .setDescription('Название, ссылка на трек, или ссылка на плейлист/альбом')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('import')
      .setDescription('Загрузить TXT-файл в чей-то плейлист')
      .addUserOption((opt) => opt.setName('user').setDescription('Чей плейлист').setRequired(true))
      .addAttachmentOption((opt) =>
        opt.setName('file').setDescription('TXT-файл, одна строка — «Исполнитель — Название»').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription('Очистить чей-то плейлист')
      .addUserOption((opt) => opt.setName('user').setDescription('Чей плейлист').setRequired(true))
  );

export async function execute(interaction) {
  const mod = requireModerator(interaction);
  if (!mod.ok) return interaction.reply({ content: mod.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  const sub = interaction.options.getSubcommand();
  const targetUser = interaction.options.getUser('user', true);
  const personal = PlaylistRepo.getOrCreatePersonal(targetUser.id);

  if (sub === 'add') return handleAdd(interaction, personal, targetUser);
  if (sub === 'import') return handleImport(interaction, personal, targetUser);
  if (sub === 'clear') return handleClear(interaction, personal, targetUser);
}

async function handleAdd(interaction, personal, targetUser) {
  const trackQuery = interaction.options.getString('track', true);

  const playlistUrl = detectPlaylistUrl(trackQuery);
  if (playlistUrl) {
    return runPlaylistUrlImport(interaction, playlistUrl, personal.id);
  }

  await interaction.deferReply({ flags: MessageFlags.SuppressNotifications });

  let result;
  try {
    result = await resolveTrackRequest(trackQuery, { addedBy: targetUser.id, playlistId: personal.id });
  } catch (err) {
    if (err instanceof UnresolvableError) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    logger.error('mod playlist add failed', { error: err.message, query: trackQuery, targetUser: targetUser.id });
    return interaction.editReply({ content: `❌ Не удалось добавить трек: ${err.message}` });
  }

  const embed = trackAddedEmbed(result.track, {
    alreadyInPlaylist: result.alreadyInPlaylist,
    playlistLabel: `плейлист ${targetUser.username}`,
  });
  const components = result.alreadyInPlaylist ? [] : undoAddRow(personal.id, result.track.id);
  return interaction.editReply({ embeds: [embed], components });
}

async function handleImport(interaction, personal, targetUser) {
  const attachment = interaction.options.getAttachment('file', true);
  if (!looksLikeTextAttachment(attachment)) {
    return interaction.reply({ content: '❌ Нужен обычный TXT-файл.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }
  return runBulkImport(interaction, attachment, personal.id);
}

async function handleClear(interaction, personal, targetUser) {
  const result = clearPlaylist(personal.id);
  if (result.removedCount === 0) {
    return interaction.reply({
      content: `ℹ️ Плейлист ${targetUser.username} и так пуст.`,
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }
  return interaction.reply({
    content: `🗑️ Плейлист ${targetUser.username} очищен: убрано ${result.removedCount} трек(ов), из них ${result.hardDeletedCount} удалено с диска (не встречались больше нигде).`,
    flags: MessageFlags.SuppressNotifications,
  });
}
