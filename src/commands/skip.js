import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Переключить на следующий случайный трек (только DJ)');

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  active.session.skip();
  return interaction.reply({ content: '⏭️ Переключаю трек...', flags: MessageFlags.Ephemeral });
}
