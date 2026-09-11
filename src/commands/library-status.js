import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../database/db.js';

export const data = new SlashCommandBuilder()
  .setName('library-status')
  .setDescription('Показать статистику библиотеки «Хайповый музон»');

export async function execute(interaction) {
  const ready = db.prepare("SELECT COUNT(*) c FROM tracks WHERE status = 'ready'").get().c;
  const failed = db.prepare("SELECT COUNT(*) c FROM tracks WHERE status = 'failed'").get().c;

  const embed = new EmbedBuilder()
    .setColor(0xff4d4d)
    .setTitle('🔥 Библиотека «Хайповый музон»')
    .addFields(
      { name: 'Готово к воспроизведению', value: String(ready), inline: true },
      { name: 'Не удалось обработать', value: String(failed), inline: true }
    );

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
