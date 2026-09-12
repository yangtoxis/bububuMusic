import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { checkVoicePreconditions } from '../utils/voiceGuards.js';
import { startHype } from '../audio/hypeControl.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Включить музыку в твоём голосовом канале (только DJ)')
  .addStringOption((opt) =>
    opt
      .setName('mode')
      .setDescription('Режим воспроизведения')
      .addChoices(
        { name: '🔥 Хайповый музон', value: 'hype' },
        { name: '🎧 Микс — плейлисты людей в канале', value: 'mix' }
      )
  );

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const voice = checkVoicePreconditions(interaction);
  if (!voice.ok) return interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });

  const mode = interaction.options.getString('mode') ?? 'hype';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await startHype({
    guild: interaction.guild,
    voiceChannel: voice.voiceChannel,
    textChannel: interaction.channel,
    mode,
  });

  if (!result.ok) return interaction.editReply({ content: result.message });

  if (mode === 'mix') {
    const labels = result.session.getMixSourceLabels();
    return interaction.editReply({ content: `🎧 Микс включён!\nВ ротации: ${labels.join(', ')}` });
  }
  return interaction.editReply({ content: '🔥 Хайповый музон включён!' });
}
