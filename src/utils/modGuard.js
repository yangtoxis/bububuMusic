import { PermissionsBitField } from 'discord.js';
import { ModRoleRepo } from '../database/ModRoleRepo.js';
import { SUPER_ADMIN_USER_ID } from './permissions.js';

// Moderators sit above DJs: assigned by a server admin (via /modrole, or
// implicitly anyone with the actual "Manage Server" permission), they can
// wipe/bulk-fill the shared library, hand out DJ roles, and manage other
// people's personal playlists - on top of everything a DJ can already do
// (see isDjMember in djGuard.js, which treats every moderator as a DJ too).
export function isModerator(member) {
  if (!member) return false;
  if (member.id === SUPER_ADMIN_USER_ID) return true;
  if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;

  const modRoleIds = ModRoleRepo.list(member.guild.id);
  if (modRoleIds.length === 0) return false;
  return member.roles.cache.some((role) => modRoleIds.includes(role.id));
}

export function requireModerator(interaction) {
  if (isModerator(interaction.member)) return { ok: true };
  return {
    ok: false,
    message: '❌ Эта команда доступна только модераторам.',
  };
}

// Who's allowed to configure moderators themselves - deliberately narrower
// than isModerator (a moderator can't grant themselves more moderators):
// real "Manage Server" permission, or the hardcoded super admin.
export function isGuildAdmin(member) {
  if (!member) return false;
  if (member.id === SUPER_ADMIN_USER_ID) return true;
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}
