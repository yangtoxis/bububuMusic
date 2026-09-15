import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { ModRoleRepo } from '../database/ModRoleRepo.js';
import { isGuildAdmin } from '../utils/modGuard.js';

// Deliberately no .setDefaultMemberPermissions() - Discord would hide the
// command entirely from anyone without that permission, including the
// hardcoded super admin on a guild where they don't happen to have it.
// Visible to everyone; isGuildAdmin() below is what actually gates it.
export const data = new SlashCommandBuilder()
  .setName('modrole')
  .setDescription('Настроить роли модераторов для этого сервера')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Добавить роль модератора')
      .addRoleOption((opt) => opt.setName('role').setDescription('Роль').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Убрать роль модератора')
      .addRoleOption((opt) => opt.setName('role').setDescription('Роль').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Показать текущие роли модераторов'));

export async function execute(interaction) {
  if (!isGuildAdmin(interaction.member)) {
    return interaction.reply({
      content: '❌ Назначать модераторов может только тот, у кого есть право «Управление сервером».',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const role = interaction.options.getRole('role', true);
    ModRoleRepo.add(interaction.guild.id, role.id);
    return interaction.reply({
      content: `✅ Роль <@&${role.id}> теперь даёт права модератора (полный контроль над плеером, библиотекой, DJ-ролями и плейлистами пользователей).`,
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }

  if (sub === 'remove') {
    const role = interaction.options.getRole('role', true);
    ModRoleRepo.remove(interaction.guild.id, role.id);
    return interaction.reply({ content: `✅ Роль <@&${role.id}> больше не даёт права модератора.`, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications });
  }

  const roles = ModRoleRepo.list(interaction.guild.id);
  if (roles.length === 0) {
    return interaction.reply({
      content: 'Роли модераторов пока не настроены. Модератором может быть только администратор сервера (право «Управление сервером»).',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
    });
  }
  return interaction.reply({
    content: `Роли модераторов: ${roles.map((r) => `<@&${r}>`).join(', ')}`,
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
  });
}
