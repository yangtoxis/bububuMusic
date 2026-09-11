import { createLogger } from './logger.js';

const logger = createLogger({ module: 'platformEmojis' });

// Real brand-icon application emoji (uploaded once via the Discord API,
// see project notes) - usable on buttons in every guild the bot is in.
// Falls back to a plain unicode glyph if the upload is ever missing so
// button rendering never breaks.
export const platformEmojis = {
  youtube: '📺',
  spotify: '🎧',
  yandex: '🎵',
};

const NAME_TO_KEY = {
  platform_youtube: 'youtube',
  platform_spotify: 'spotify',
  platform_yandex: 'yandex',
};

export async function loadPlatformEmojis(client) {
  try {
    const emojis = await client.application.emojis.fetch();
    for (const emoji of emojis.values()) {
      const key = NAME_TO_KEY[emoji.name];
      if (key) platformEmojis[key] = { id: emoji.id, name: emoji.name };
    }
    logger.info('platform emojis loaded', {
      youtube: typeof platformEmojis.youtube === 'object',
      spotify: typeof platformEmojis.spotify === 'object',
      yandex: typeof platformEmojis.yandex === 'object',
    });
  } catch (err) {
    logger.warn('failed to load application emojis, falling back to unicode', { error: err.message });
  }
}
