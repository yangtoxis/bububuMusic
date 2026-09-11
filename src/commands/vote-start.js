import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { checkVoicePreconditions } from '../utils/voiceGuards.js';
import { isDjInVoiceChannel } from '../utils/djGuard.js';
import { audioManager } from '../audio/AudioManager.js';
import { TrackRepo } from '../database/TrackRepo.js';
import { voteManager } from '../voting/VoteManager.js';
import { startHype } from '../audio/hypeControl.js';

export const data = new SlashCommandBuilder()
  .setName('vote-start')
  .setDescription('Запустить голосование за включение «Хайпового музона»');

export async function execute(interaction) {
  if (audioManager.has(interaction.guild.id)) {
    return interaction.reply({ content: '❌ Хайповый музон уже играет.', flags: MessageFlags.Ephemeral });
  }

  if (TrackRepo.countReady() === 0) {
    return interaction.reply({
      content: '❌ В библиотеке «Хайповый музон» пока нет треков — голосовать не за что.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const voice = checkVoicePreconditions(interaction);
  if (!voice.ok) return interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });

  if (isDjInVoiceChannel(voice.voiceChannel)) {
    return interaction.reply({
      content: 'ℹ️ В канале уже есть DJ — попроси его включить музыку через `/hype`, голосование не требуется.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (voteManager.hasActive(interaction.guild.id, 'start')) {
    return interaction.reply({
      content: 'ℹ️ Голосование уже запущено — присоединяйся к нему кнопкой в сообщении выше.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await voteManager.start({
    guild: interaction.guild,
    kind: 'start',
    starter: interaction.user,
    voiceChannel: voice.voiceChannel,
    textChannel: interaction.channel,
    onThresholdReached: async () => {
      const result = await startHype({
        guild: interaction.guild,
        voiceChannel: voice.voiceChannel,
        textChannel: interaction.channel,
      });
      if (!result.ok) {
        await interaction.channel.send({ content: result.message });
      }
    },
  });

  return interaction.editReply({ content: '🔥 Голосование запущено!' });
}
