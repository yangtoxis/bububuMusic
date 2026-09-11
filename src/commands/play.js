import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { checkVoicePreconditions } from '../utils/voiceGuards.js';
import { startHype } from '../audio/hypeControl.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Включить «Хайповый музон» в твоём голосовом канале (только DJ)');

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const voice = checkVoicePreconditions(interaction);
  if (!voice.ok) return interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await startHype({
    guild: interaction.guild,
    voiceChannel: voice.voiceChannel,
    textChannel: interaction.channel,
  });

  if (!result.ok) return interaction.editReply({ content: result.message });
  return interaction.editReply({ content: '🔥 Хайповый музон включён!' });
}
