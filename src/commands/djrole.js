import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { DjRoleRepo } from '../database/DjRoleRepo.js';
import { isModerator } from '../utils/modGuard.js';

// Deliberately no .setDefaultMemberPermissions() - Discord would hide the
// command entirely from anyone without that permission, including the
// hardcoded super admin on a guild where they don't happen to have it.
// Visible to everyone; isModerator() below is what actually gates it.
export const data = new SlashCommandBuilder()
  .setName('djrole')
  .setDescription('Настроить роли DJ для этого сервера')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Добавить роль DJ')
      .addRoleOption((opt) => opt.setName('role').setDescription('Роль').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Убрать роль DJ')
      .addRoleOption((opt) => opt.setName('role').setDescription('Роль').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Показать текущие роли DJ'));

export async function execute(interaction) {
  if (!isModerator(interaction.member)) {
    return interaction.reply({
      content: '❌ Настраивать роли DJ может только модератор или тот, у кого есть право «Управление сервером».',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const role = interaction.options.getRole('role', true);
    DjRoleRepo.add(interaction.guild.id, role.id);
    return interaction.reply({ content: `✅ Роль <@&${role.id}> теперь даёт права DJ.`, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }

  if (sub === 'remove') {
    const role = interaction.options.getRole('role', true);
    DjRoleRepo.remove(interaction.guild.id, role.id);
    return interaction.reply({ content: `✅ Роль <@&${role.id}> больше не даёт права DJ.`, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }

  const roles = DjRoleRepo.list(interaction.guild.id);
  if (roles.length === 0) {
    return interaction.reply({
      content: 'Роли DJ пока не настроены. Только администраторы (право «Управление сервером») могут управлять музыкой напрямую — остальным доступно только голосование.',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }
  return interaction.reply({
    content: `Роли DJ: ${roles.map((r) => `<@&${r}>`).join(', ')}`,
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
  });
}
