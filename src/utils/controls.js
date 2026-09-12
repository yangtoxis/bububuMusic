import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { trackLabel } from './format.js';
import { platformEmojis } from './platformEmojis.js';

export function playerControlRows(session) {
  const isPaused = session?.isPaused ?? false;

  const transportRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctrl:prev').setStyle(ButtonStyle.Secondary).setEmoji('⏮️'),
    new ButtonBuilder().setCustomId('ctrl:stop').setStyle(ButtonStyle.Danger).setEmoji('⏹️'),
    new ButtonBuilder()
      .setCustomId('ctrl:playpause')
      .setStyle(ButtonStyle.Primary)
      .setEmoji(isPaused ? '▶️' : '⏸️'),
    new ButtonBuilder().setCustomId('ctrl:next').setStyle(ButtonStyle.Secondary).setEmoji('⏭️')
  );

  const volumeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctrl:voldown').setStyle(ButtonStyle.Secondary).setEmoji('🔉'),
    new ButtonBuilder().setCustomId('ctrl:volup').setStyle(ButtonStyle.Secondary).setEmoji('🔊')
  );

  const rows = [transportRow, volumeRow];

  const track = session?.currentTrack;
  if (track) {
    const query = encodeURIComponent(trackLabel(track));
    const linkRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(`https://www.youtube.com/results?search_query=${query}`)
        .setEmoji(platformEmojis.youtube),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(`https://open.spotify.com/search/${query}`)
        .setEmoji(platformEmojis.spotify),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(`https://music.yandex.ru/search?text=${query}`)
        .setEmoji(platformEmojis.yandex),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(`https://soundcloud.com/search?q=${query}`)
        .setEmoji(platformEmojis.soundcloud)
    );
    rows.push(linkRow);
  }

  return rows;
}

export function voteRow(kind) {
  const customId = kind === 'start' ? 'vote:start:join' : 'vote:stop:join';
  const label = kind === 'start' ? 'Голосовать за включение' : 'Голосовать за отключение';
  const emoji = kind === 'start' ? '🔥' : '🛑';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Primary)
  );
  return [row];
}

export function undoAddRow(playlistId, trackId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`track:unlink:${playlistId}:${trackId}`)
      .setLabel('Отменить')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Danger)
  );
  return [row];
}

export function undoRemoveRow(playlistId, trackId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`track:relink:${playlistId}:${trackId}`)
      .setLabel('Отменить')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

export function queueShuffleRow() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('queue:shuffle').setLabel('Перемешать').setEmoji('🔀').setStyle(ButtonStyle.Secondary)
  );
  return [row];
}
