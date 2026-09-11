import { PermissionsBitField } from 'discord.js';
import { audioManager } from '../audio/AudioManager.js';

export function checkVoicePreconditions(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return { ok: false, message: '❌ Нужно находиться в голосовом канале.' };
  }

  const perms = voiceChannel.permissionsFor(interaction.client.user);
  if (!perms?.has(PermissionsBitField.Flags.Connect)) {
    return { ok: false, message: '❌ У бота нет прав подключиться к этому каналу.' };
  }
  if (!perms?.has(PermissionsBitField.Flags.Speak)) {
    return { ok: false, message: '❌ У бота нет прав говорить в этом канале.' };
  }

  const existing = audioManager.get(interaction.guild.id);
  if (existing && existing.voiceChannel.id !== voiceChannel.id) {
    return { ok: false, message: `❌ Бот уже играет в другом канале (<#${existing.voiceChannel.id}>).` };
  }

  return { ok: true, voiceChannel };
}

export function requireActiveSession(interaction) {
  const session = audioManager.get(interaction.guild.id);
  if (!session) {
    return { ok: false, message: '❌ Сейчас ничего не играет.' };
  }
  return { ok: true, session };
}
