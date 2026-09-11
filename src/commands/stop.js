import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { stopHype } from '../audio/hypeControl.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Выключить бота и остановить «Хайповый музон» (только DJ)');

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  stopHype(interaction.guild.id, 'dj_stop');
  return interaction.reply({ content: '⏹️ Хайповый музон выключен.' });
}
