import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Поставить музыку на паузу или снять с паузы (только DJ)');

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  if (active.session.isPaused) {
    active.session.resume();
    return interaction.reply({ content: '▶️ Продолжаю воспроизведение.' });
  }

  active.session.pause();
  return interaction.reply({ content: '⏸️ Пауза.' });
}
