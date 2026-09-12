import { MessageFlags } from 'discord.js';
import { parseTrackList } from './parseTrackList.js';
import { libraryImportQueue } from './LibraryImportQueue.js';
import { detectPlaylistUrl, resolvePlaylistUrlItems } from './PlaylistUrlResolver.js';
import { UnresolvableError } from './TrackResolver.js';
import { ImportJobRepo } from '../database/ImportJobRepo.js';
import { importSummaryEmbed } from '../utils/embeds.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'bulkImportFlow' });
const EDIT_EVERY_N = 5;
const MAX_FAILED_SHOWN = 15;

export function looksLikeTextAttachment(attachment) {
  return attachment.contentType?.startsWith('text/') || attachment.name?.toLowerCase().endsWith('.txt');
}

// Core shared by every bulk-import entry point (TXT attachment, playlist
// URL): takes an already-resolved list of { raw, artist, title } items and
// runs them through the background import queue with a live progress
// embed. `interaction` just needs deferReply/editReply to already have run
// - works the same for a chat input or context menu interaction.
async function runItemsImport(interaction, items, playlistId, label) {
  const job = ImportJobRepo.create({
    guildId: interaction.guild.id,
    requestedBy: interaction.user.id,
    filename: label,
    totalLines: items.length,
    channelId: interaction.channel.id,
  });

  const initialEmbed = importSummaryEmbed(
    { total: items.length, processed: 0, added: 0, existing: 0, failed: 0 },
    { title: `Импорт «${label}»`, done: false }
  );
  const progressMessage = await interaction.editReply({ embeds: [initialEmbed] });
  ImportJobRepo.setMessageId(job.id, progressMessage.id);

  libraryImportQueue.enqueue(job, items, {
    playlistId,
    onProgress: async (counts, state, done) => {
      const shouldEdit = done || counts.processed % EDIT_EVERY_N === 0 || counts.processed === items.length;
      if (!shouldEdit) return;

      const embed = importSummaryEmbed({ total: items.length, ...counts }, { title: `Импорт «${label}»`, done });

      if (done && state.failedItems.length > 0) {
        const shown = state.failedItems.slice(0, MAX_FAILED_SHOWN);
        const extra = state.failedItems.length - shown.length;
        let value = shown.map((f) => `• ${f.raw} — _${f.reason}_`).join('\n');
        if (extra > 0) value += `\n…и ещё ${extra}.`;
        if (value.length > 1024) value = `${value.slice(0, 1000)}…`;
        embed.addFields({ name: 'Не удалось обработать', value });
      }

      try {
        await progressMessage.edit({ embeds: [embed] });
      } catch (err) {
        logger.warn('failed to edit import progress message', { error: err.message });
      }
    },
  });
}

/**
 * Bulk-imports from a TXT attachment ("Исполнитель — Название" per line).
 * `playlistId` is where resolved tracks get linked (the shared library
 * playlist, or a caller's personal one).
 */
export async function runBulkImport(interaction, attachment, playlistId) {
  await interaction.deferReply({ flags: MessageFlags.SuppressNotifications });

  let text;
  try {
    const res = await fetch(attachment.url);
    text = await res.text();
  } catch (err) {
    logger.error('failed to fetch attachment', { error: err.message });
    return interaction.editReply({ content: '❌ Не удалось скачать прикреплённый файл.' });
  }

  const items = parseTrackList(text);
  if (items.length === 0) {
    return interaction.editReply({ content: '❌ Файл пуст или не содержит ни одной строки.' });
  }

  return runItemsImport(interaction, items, playlistId, attachment.name);
}

/**
 * Bulk-imports every track a Spotify/Yandex Music/SoundCloud playlist or
 * album link points to. Only ever reads that platform's public page for
 * track names/artists - the actual audio always comes from YouTube per
 * track, same as a single-track add.
 */
export async function runPlaylistUrlImport(interaction, detected, playlistId) {
  await interaction.deferReply({ flags: MessageFlags.SuppressNotifications });
  await interaction.editReply({ content: `⏳ Получаю список треков плейлиста с ${detected.label}...` });

  let items;
  try {
    items = await resolvePlaylistUrlItems(detected);
  } catch (err) {
    if (err instanceof UnresolvableError) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    logger.error('playlist url resolution failed', { error: err.message, url: detected.url });
    return interaction.editReply({ content: `❌ Не удалось получить плейлист: ${err.message}` });
  }

  if (items.length === 0) {
    return interaction.editReply({ content: '❌ Не нашёл ни одного трека по этой ссылке.' });
  }

  return runItemsImport(interaction, items, playlistId, `${detected.label}: плейлист`);
}
