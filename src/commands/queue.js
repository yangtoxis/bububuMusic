import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { queueEmbed } from '../utils/embeds.js';
import { queueShuffleRow } from '../utils/controls.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Показать следующие треки в очереди');

export async function execute(interaction) {
  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });

  return interaction.reply({
    embeds: [queueEmbed(active.session)],
    components: queueShuffleRow(),
    flags: MessageFlags.SuppressNotifications,
  });
}
