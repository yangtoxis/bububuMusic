import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { runBulkImport, looksLikeTextAttachment } from '../library/bulkImportFlow.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';

export const data = new SlashCommandBuilder()
  .setName('import')
  .setDescription('Массово добавить треки из TXT-файла в «Хайповый музон» (только DJ)')
  .addAttachmentOption((opt) =>
    opt
      .setName('file')
      .setDescription('TXT-файл, одна строка — «Исполнитель — Название»')
      .setRequired(true)
  );

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  const attachment = interaction.options.getAttachment('file', true);
  if (!looksLikeTextAttachment(attachment)) {
    return interaction.reply({ content: '❌ Нужен обычный TXT-файл.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }

  const library = PlaylistRepo.getOrCreateLibrary();
  return runBulkImport(interaction, attachment, library.id);
}
