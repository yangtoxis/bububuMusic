import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { ListeningStatsRepo } from '../database/ListeningStatsRepo.js';

const HYPE_COLOR = 0xff4d4d;
const MEDALS = ['🥇', '🥈', '🥉'];

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин`;
  return '<1 мин';
}

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Топ-10 слушателей на этом сервере');

export async function execute(interaction) {
  const top = ListeningStatsRepo.getTop(interaction.guild.id, 10);

  if (!top.length) {
    return interaction.reply({
      content: 'ℹ️ Пока никто не слушал музыку на этом сервере.',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }

  const lines = top.map((row, i) => {
    const rank = MEDALS[i] || `${i + 1}.`;
    return `${rank} <@${row.user_id}> — **${formatDuration(row.seconds_listened)}**`;
  });

  const embed = new EmbedBuilder()
    .setColor(HYPE_COLOR)
    .setTitle('🏆 Топ слушателей')
    .setDescription(lines.join('\n'));

  return interaction.reply({ embeds: [embed], flags: MessageFlags.SuppressNotifications });
}
