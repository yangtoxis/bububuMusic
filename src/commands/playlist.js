import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { resolveTrackRequest, UnresolvableError } from '../library/TrackResolver.js';
import { detectPlaylistUrl } from '../library/PlaylistUrlResolver.js';
import { runBulkImport, runPlaylistUrlImport, looksLikeTextAttachment } from '../library/bulkImportFlow.js';
import { clearPlaylist } from '../library/playlistOps.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { trackAddedEmbed } from '../utils/embeds.js';
import { undoAddRow } from '../utils/controls.js';
import { trackLabel, formatDuration } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'playlist' });
const STATUS_PREVIEW_COUNT = 15;

export const data = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Твой личный плейлист для режима «Микс»')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Добавить трек или ссылку на плейлист в свой плейлист')
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
      .setDescription('Загрузить список треков из TXT-файла в свой плейлист')
      .addAttachmentOption((opt) =>
        opt.setName('file').setDescription('TXT-файл, одна строка — «Исполнитель — Название»').setRequired(true)
      )
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Показать свой плейлист'))
  .addSubcommand((sub) => sub.setName('clear').setDescription('Очистить свой плейлист'));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const personal = PlaylistRepo.getOrCreatePersonal(interaction.user.id);

  if (sub === 'add') return handleAdd(interaction, personal);
  if (sub === 'import') return handleImport(interaction, personal);
  if (sub === 'status') return handleStatus(interaction, personal);
  if (sub === 'clear') return handleClear(interaction, personal);
}

async function handleAdd(interaction, personal) {
  const trackQuery = interaction.options.getString('track', true);

  const playlistUrl = detectPlaylistUrl(trackQuery);
  if (playlistUrl) {
    return runPlaylistUrlImport(interaction, playlistUrl, personal.id);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let result;
  try {
    result = await resolveTrackRequest(trackQuery, { addedBy: interaction.user.id, playlistId: personal.id });
  } catch (err) {
    if (err instanceof UnresolvableError) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    logger.error('personal playlist add failed', { error: err.message, query: trackQuery });
    return interaction.editReply({ content: `❌ Не удалось добавить трек: ${err.message}` });
  }

  const embed = trackAddedEmbed(result.track, {
    alreadyInPlaylist: result.alreadyInPlaylist,
    playlistLabel: 'твой плейлист',
  });
  const components = result.alreadyInPlaylist ? [] : undoAddRow(personal.id, result.track.id);
  return interaction.editReply({ embeds: [embed], components });
}

async function handleImport(interaction, personal) {
  const attachment = interaction.options.getAttachment('file', true);
  if (!looksLikeTextAttachment(attachment)) {
    return interaction.reply({ content: '❌ Нужен обычный TXT-файл.', flags: MessageFlags.Ephemeral });
  }
  return runBulkImport(interaction, attachment, personal.id);
}

async function handleStatus(interaction, personal) {
  const tracks = PlaylistRepo.listReady(personal.id);
  if (tracks.length === 0) {
    return interaction.reply({
      content: 'ℹ️ Твой плейлист пуст. Добавь треки через `/playlist add` или `/playlist import`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const shown = tracks.slice(0, STATUS_PREVIEW_COUNT);
  const lines = shown.map((t, i) => `**${i + 1}.** ${trackLabel(t)}${t.duration_seconds ? ` (${formatDuration(t.duration_seconds)})` : ''}`);
  const extra = tracks.length - shown.length;
  let content = `🎧 **Твой плейлист** — ${tracks.length} трек(ов):\n${lines.join('\n')}`;
  if (extra > 0) content += `\n…и ещё ${extra}.`;

  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleClear(interaction, personal) {
  const result = clearPlaylist(personal.id);
  if (result.removedCount === 0) {
    return interaction.reply({ content: 'ℹ️ Твой плейлист и так пуст.', flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({
    content: `🗑️ Плейлист очищен: убрано ${result.removedCount} трек(ов), из них ${result.hardDeletedCount} удалено с диска (не встречались больше нигде).`,
    flags: MessageFlags.Ephemeral,
  });
}
