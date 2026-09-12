import { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { runBulkImport, looksLikeTextAttachment } from '../library/bulkImportFlow.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';

// A message-context-menu command (right-click a message → Apps →
// "Импортировать треки из TXT") rather than a slash-command option, so
// /add stays a single always-a-string field - no "file or text?" choice to
// make. Bulk import instead reuses whatever TXT file is already attached
// to the message you right-click.
export const data = new ContextMenuCommandBuilder()
  .setName('Импортировать треки из TXT')
  .setType(ApplicationCommandType.Message);

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  const message = interaction.targetMessage;
  const attachment = message.attachments.find(looksLikeTextAttachment);
  if (!attachment) {
    return interaction.reply({
      content: '❌ В этом сообщении нет TXT-файла для импорта.',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }

  const library = PlaylistRepo.getOrCreateLibrary();
  return runBulkImport(interaction, attachment, library.id);
}
