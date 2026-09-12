import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { audioManager } from './AudioManager.js';

// Shared by /play, the panel buttons and both vote outcomes so there is
// exactly one place that decides whether the station is allowed to start.
export async function startHype({ guild, voiceChannel, textChannel, mode = 'hype' }) {
  if (audioManager.has(guild.id)) {
    return { ok: false, message: 'Хайповый музон уже играет.' };
  }

  const library = PlaylistRepo.getOrCreateLibrary();
  if (PlaylistRepo.countReady(library.id) === 0) {
    return {
      ok: false,
      message: 'В библиотеке «Хайповый музон» пока нет треков. Добавь их командой `/add`.',
    };
  }

  const session = audioManager.getOrCreate({ guild, voiceChannel, textChannel });
  try {
    await session.start(mode);
  } catch (err) {
    session.destroy('start_failed');
    return { ok: false, message: `❌ Не удалось подключиться к голосовому каналу: ${err.message}` };
  }
  return { ok: true, session };
}

export function stopHype(guildId, reason = 'manual_stop') {
  const session = audioManager.get(guildId);
  if (!session) return { ok: false, message: 'Бот и так не в голосовом канале.' };
  session.destroy(reason);
  return { ok: true };
}
