import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireModerator } from '../utils/modGuard.js';
import { clearPlaylist } from '../library/playlistOps.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';

export const data = new SlashCommandBuilder()
  .setName('library-clear')
  .setDescription('Полностью очистить библиотеку «Хайповый музон» (только модераторы)');

export async function execute(interaction) {
  const mod = requireModerator(interaction);
  if (!mod.ok) return interaction.reply({ content: mod.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  const library = PlaylistRepo.getOrCreateLibrary();
  const result = clearPlaylist(library.id);

  if (result.removedCount === 0) {
    return interaction.reply({ content: 'ℹ️ Библиотека и так пуста.', flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }

  return interaction.reply({
    content: `🗑️ Библиотека очищена: убрано ${result.removedCount} трек(ов), из них ${result.hardDeletedCount} удалено с диска (не встречались больше нигде).`,
    flags: MessageFlags.SuppressNotifications,
  });
}
