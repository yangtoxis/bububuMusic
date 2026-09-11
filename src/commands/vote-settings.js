import { SlashCommandBuilder, PermissionsBitField, MessageFlags } from 'discord.js';
import { GuildSettingsRepo } from '../database/GuildSettingsRepo.js';

export const data = new SlashCommandBuilder()
  .setName('vote-settings')
  .setDescription('Настроить порог голосований (% от числа людей в голосовом канале)')
  .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
  .addIntegerOption((opt) =>
    opt.setName('start_percent').setDescription('Порог для голосования за включение, %').setMinValue(1).setMaxValue(100)
  )
  .addIntegerOption((opt) =>
    opt.setName('stop_percent').setDescription('Порог для голосования за отключение, %').setMinValue(1).setMaxValue(100)
  );

export async function execute(interaction) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({
      content: '❌ Настраивать голосования может только тот, у кого есть право «Управление сервером».',
      flags: MessageFlags.Ephemeral,
    });
  }

  const startPercent = interaction.options.getInteger('start_percent');
  const stopPercent = interaction.options.getInteger('stop_percent');

  if (startPercent == null && stopPercent == null) {
    const settings = GuildSettingsRepo.get(interaction.guild.id);
    return interaction.reply({
      content: `Текущие пороги: включение — ${settings.vote_start_percent}%, отключение — ${settings.vote_stop_percent}%.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (startPercent != null) GuildSettingsRepo.setVoteStartPercent(interaction.guild.id, startPercent);
  if (stopPercent != null) GuildSettingsRepo.setVoteStopPercent(interaction.guild.id, stopPercent);

  return interaction.reply({ content: '✅ Настройки голосований обновлены.', flags: MessageFlags.Ephemeral });
}
