import { MessageFlags } from 'discord.js';
import { trackAnnouncementEmbed } from './embeds.js';
import { playerControlRows } from './controls.js';
import { createLogger } from './logger.js';

const logger = createLogger({ module: 'attachSessionUI' });

// Wires a session's playback events to channel-side effects. Called exactly
// once per session (from AudioManager.getOrCreate) so listeners never pile
// up across repeated /play calls on the same guild.
export function attachSessionUI(session) {
  session.on('trackChange', async () => {
    await postTrackAnnouncement(session);
  });

  session.on('trackError', async ({ track }) => {
    try {
      await session.textChannel.send({
        content: `⚠️ Не удалось воспроизвести «${track?.artist ?? '?'} — ${track?.title ?? '?'}», пропускаю.`,
      });
    } catch (err) {
      logger.warn('failed to post track error notice', { error: err.message });
    }
  });

  session.on('error', async (message) => {
    try {
      await session.textChannel.send({ content: `⚠️ ${message}` });
    } catch (err) {
      logger.warn('failed to post session error', { error: err.message });
    }
  });

  session.on('empty', async () => {
    try {
      await session.textChannel.send({ content: 'В библиотеке «Хайповый музон» пока нет треков.' });
    } catch (err) {
      logger.warn('failed to post empty-library notice', { error: err.message });
    }
  });
}

export async function postTrackAnnouncement(session) {
  if (session.lastAnnouncementMessage) {
    try {
      await session.lastAnnouncementMessage.delete();
    } catch {
      /* already gone */
    }
  }

  try {
    const message = await session.textChannel.send({
      embeds: [trackAnnouncementEmbed(session)],
      components: playerControlRows(session),
      flags: MessageFlags.SuppressNotifications,
    });
    session.lastAnnouncementMessage = message;
    return message;
  } catch (err) {
    logger.warn('failed to post track announcement', { error: err.message });
    return null;
  }
}
