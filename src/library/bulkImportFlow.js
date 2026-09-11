import { parseTrackList } from './parseTrackList.js';
import { libraryImportQueue } from './LibraryImportQueue.js';
import { ImportJobRepo } from '../database/ImportJobRepo.js';
import { importSummaryEmbed } from '../utils/embeds.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'bulkImportFlow' });
const EDIT_EVERY_N = 5;
const MAX_FAILED_SHOWN = 15;

export function looksLikeTextAttachment(attachment) {
  return attachment.contentType?.startsWith('text/') || attachment.name?.toLowerCase().endsWith('.txt');
}

// Shared by any entry point that hands the bot a TXT attachment to bulk-
// import (currently: the "Импортировать треки из TXT" message context menu
// command). `interaction` just needs deferReply/editReply - works the same
// for a chat input or context menu interaction.
export async function runBulkImport(interaction, attachment) {
  await interaction.deferReply();

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

  const job = ImportJobRepo.create({
    guildId: interaction.guild.id,
    requestedBy: interaction.user.id,
    filename: attachment.name,
    totalLines: items.length,
    channelId: interaction.channel.id,
  });

  const initialEmbed = importSummaryEmbed(
    { total: items.length, processed: 0, added: 0, existing: 0, failed: 0 },
    { title: `Импорт «${attachment.name}»`, done: false }
  );
  const progressMessage = await interaction.editReply({ embeds: [initialEmbed] });
  ImportJobRepo.setMessageId(job.id, progressMessage.id);

  libraryImportQueue.enqueue(job, items, {
    onProgress: async (counts, state, done) => {
      const shouldEdit = done || counts.processed % EDIT_EVERY_N === 0 || counts.processed === items.length;
      if (!shouldEdit) return;

      const embed = importSummaryEmbed(
        { total: items.length, ...counts },
        { title: `Импорт «${attachment.name}»`, done }
      );

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
