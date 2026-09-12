import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../database/db.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';

export const data = new SlashCommandBuilder()
  .setName('library-status')
  .setDescription('Показать статистику библиотеки «Хайповый музон»');

export async function execute(interaction) {
  const library = PlaylistRepo.getOrCreateLibrary();
  const ready = PlaylistRepo.countReady(library.id);
  const failed = db.prepare("SELECT COUNT(*) c FROM tracks WHERE status = 'failed'").get().c;
  const personalPlaylists = db.prepare("SELECT COUNT(*) c FROM playlists WHERE kind = 'personal'").get().c;

  const embed = new EmbedBuilder()
    .setColor(0xff4d4d)
    .setTitle('🔥 Библиотека «Хайповый музон»')
    .addFields(
      { name: 'Готово к воспроизведению', value: String(ready), inline: true },
      { name: 'Не удалось обработать', value: String(failed), inline: true },
      { name: 'Личных плейлистов создано', value: String(personalPlaylists), inline: true }
    );

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
}
