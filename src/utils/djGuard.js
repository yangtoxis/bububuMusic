import { PermissionsBitField } from 'discord.js';
import { DjRoleRepo } from '../database/DjRoleRepo.js';
import { isModerator } from './modGuard.js';
import { SUPER_ADMIN_USER_ID } from './permissions.js';

// A guild that hasn't configured any DJ role yet has no DJs at all (aside
// from server admins/moderators) - NOT "everyone is a DJ". That's what
// keeps the vote-to-play fallback meaningful by default instead of being a
// no-op until someone remembers to run /djrole.
export function isDjMember(member) {
  if (!member) return false;
  if (member.id === SUPER_ADMIN_USER_ID) return true;
  if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  if (isModerator(member)) return true;

  const djRoleIds = DjRoleRepo.list(member.guild.id);
  if (djRoleIds.length === 0) return false;
  return member.roles.cache.some((role) => djRoleIds.includes(role.id));
}

export function isDjInVoiceChannel(voiceChannel) {
  if (!voiceChannel) return false;
  return voiceChannel.members.some((m) => !m.user.bot && isDjMember(m));
}

export function requireDJ(interaction) {
  if (isDjMember(interaction.member)) return { ok: true };
  return {
    ok: false,
    message: '❌ Эта команда доступна только DJ. Попроси DJ выполнить действие или запусти голосование.',
  };
}
