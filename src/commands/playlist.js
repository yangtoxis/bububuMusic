import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { resolveTrackRequest, UnresolvableError } from '../library/TrackResolver.js';
import { detectPlaylistUrl } from '../library/PlaylistUrlResolver.js';
import { runBulkImport, runPlaylistUrlImport, looksLikeTextAttachment } from '../library/bulkImportFlow.js';
import { clearPlaylist, removeTrackFromPlaylist } from '../library/playlistOps.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { TrackRepo } from '../database/TrackRepo.js';
import { trackAddedEmbed, trackRemovedEmbed } from '../utils/embeds.js';
import { undoAddRow, undoRemoveRow } from '../utils/controls.js';
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
  .addSubcommand((sub) => sub.setName('clear').setDescription('Очистить свой плейлист'))
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Убрать трек из своего плейлиста (в т.ч. если он играет прямо сейчас)')
      .addStringOption((opt) =>
        opt
          .setName('track')
          .setDescription('Какой трек убрать')
          .setRequired(true)
          .setAutocomplete(true)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const personal = PlaylistRepo.getOrCreatePersonal(interaction.user.id);

  if (sub === 'add') return handleAdd(interaction, personal, interaction.options.getString('track', true));
  if (sub === 'import') return handleImport(interaction, personal);
  if (sub === 'status') return handleStatus(interaction, personal);
  if (sub === 'clear') return handleClear(interaction, personal);
  if (sub === 'remove') return handleRemove(interaction, personal);
}

export async function autocomplete(interaction) {
  if (interaction.options.getSubcommand() !== 'remove') return interaction.respond([]);

  const personal = PlaylistRepo.getOrCreatePersonal(interaction.user.id);
  const typed = interaction.options.getFocused().toLowerCase();
  const tracks = PlaylistRepo.listReady(personal.id);

  const matches = tracks
    .filter((t) => trackLabel(t).toLowerCase().includes(typed))
    .slice(0, 25)
    .map((t) => ({ name: trackLabel(t).slice(0, 100), value: String(t.id) }));

  return interaction.respond(matches);
}

// Exported so the "Добавить плейлист" button in Микс mode (anyone can use
// it - see buttonHandler.js/modalHandler.js) can add to the clicking
// user's personal playlist via a modal, without duplicating this logic.
export async function handleAdd(interaction, personal, trackQuery) {
  const playlistUrl = detectPlaylistUrl(trackQuery);
  if (playlistUrl) {
    return runPlaylistUrlImport(interaction, playlistUrl, personal.id);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

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
    return interaction.reply({ content: '❌ Нужен обычный TXT-файл.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }
  return runBulkImport(interaction, attachment, personal.id);
}

async function handleStatus(interaction, personal) {
  const tracks = PlaylistRepo.listReady(personal.id);
  if (tracks.length === 0) {
    return interaction.reply({
      content: 'ℹ️ Твой плейлист пуст. Добавь треки через `/playlist add` или `/playlist import`.',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }

  const shown = tracks.slice(0, STATUS_PREVIEW_COUNT);
  const lines = shown.map((t, i) => `**${i + 1}.** ${trackLabel(t)}${t.duration_seconds ? ` (${formatDuration(t.duration_seconds)})` : ''}`);
  const extra = tracks.length - shown.length;
  let content = `🎧 **Твой плейлист** — ${tracks.length} трек(ов):\n${lines.join('\n')}`;
  if (extra > 0) content += `\n…и ещё ${extra}.`;

  return interaction.reply({ content, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
}

async function handleClear(interaction, personal) {
  const result = clearPlaylist(personal.id);
  if (result.removedCount === 0) {
    return interaction.reply({ content: 'ℹ️ Твой плейлист и так пуст.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }
  return interaction.reply({
    content: `🗑️ Плейлист очищен: убрано ${result.removedCount} трек(ов), из них ${result.hardDeletedCount} удалено с диска (не встречались больше нигде).`,
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
  });
}

async function handleRemove(interaction, personal) {
  const trackId = Number.parseInt(interaction.options.getString('track', true), 10);

  if (!Number.isFinite(trackId) || !PlaylistRepo.isLinked(personal.id, trackId)) {
    return interaction.reply({
      content: '❌ Не нашёл такой трек в твоём плейлисте — выбери один из подсказок при вводе.',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }

  const track = TrackRepo.getById(trackId);
  const result = removeTrackFromPlaylist(personal.id, trackId);

  return interaction.reply({
    embeds: [trackRemovedEmbed(track, { playlistLabel: 'твоего плейлиста' })],
    components: result.hardDeleted ? [] : undoRemoveRow(personal.id, trackId),
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
  });
}
