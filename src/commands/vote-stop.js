import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { voteManager } from '../voting/VoteManager.js';
import { stopHype } from '../audio/hypeControl.js';

export const data = new SlashCommandBuilder()
  .setName('vote-stop')
  .setDescription('Запустить голосование за отключение бота');

export async function execute(interaction) {
  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  const memberVoiceChannel = interaction.member?.voice?.channel;
  if (!memberVoiceChannel || memberVoiceChannel.id !== active.session.voiceChannel.id) {
    return interaction.reply({
      content: '❌ Голосовать может только тот, кто находится в голосовом канале вместе с ботом.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (voteManager.hasActive(interaction.guild.id, 'stop')) {
    return interaction.reply({
      content: 'ℹ️ Голосование уже запущено — присоединяйся к нему кнопкой в сообщении выше.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await voteManager.start({
    guild: interaction.guild,
    kind: 'stop',
    starter: interaction.user,
    voiceChannel: memberVoiceChannel,
    textChannel: interaction.channel,
    onThresholdReached: async () => {
      stopHype(interaction.guild.id, 'vote_stop');
    },
  });

  return interaction.editReply({ content: '🛑 Голосование запущено!' });
}
