import { EmbedBuilder } from 'discord.js';
import { formatDuration, trackLabel, progressBar } from './format.js';

const HYPE_COLOR = 0xff4d4d;

export function trackAnnouncementEmbed(session) {
  const track = session?.currentTrack;
  const title = session?.mode === 'mix' ? '🎧 МИКС' : '🔥 ХАЙПОВЫЙ МУЗОН';
  const embed = new EmbedBuilder().setColor(HYPE_COLOR).setTitle(title);

  if (!track) {
    embed.setDescription('Сейчас ничего не играет.');
    return embed;
  }

  embed.setDescription(`**${trackLabel(track)}**`);
  if (track.thumbnail_url) embed.setThumbnail(track.thumbnail_url);

  const fields = [{ name: 'Громкость', value: `${session.volume}%`, inline: true }];
  if (track.duration_seconds) {
    fields.push({ name: 'Длительность', value: formatDuration(track.duration_seconds), inline: true });
  }
  if (session?.mode === 'mix' && track._sourceLabel) {
    fields.push({ name: 'Из плейлиста', value: track._sourceLabel, inline: true });
  }
  embed.addFields(fields);
  embed.setFooter({ text: session.isPaused ? '⏸️ На паузе' : '▶️ Играет' });

  return embed;
}

export function queueEmbed(session) {
  const embed = new EmbedBuilder().setColor(HYPE_COLOR).setTitle('📜 Следующие треки');
  const upcoming = session.getUpcoming();

  if (upcoming.length === 0) {
    embed.setDescription('Очередь пуста.');
    return embed;
  }

  const lines = upcoming.map((t, i) => {
    const duration = t.duration_seconds ? ` (${formatDuration(t.duration_seconds)})` : '';
    const source = session.mode === 'mix' && t._sourceLabel ? ` — _${t._sourceLabel}_` : '';
    return `**${i + 1}.** ${trackLabel(t)}${duration}${source}`;
  });
  embed.setDescription(lines.join('\n'));
  return embed;
}

export function importSummaryEmbed(counts, { title = 'Импорт библиотеки завершён', done = false } = {}) {
  const status = done ? '✅ Готово' : '⏳ В процессе...';
  return new EmbedBuilder()
    .setColor(done ? 0x57f287 : 0xfee75c)
    .setTitle(title)
    .setDescription(status)
    .addFields(
      { name: 'Всего строк', value: String(counts.total ?? '—'), inline: true },
      { name: 'Обработано', value: String(counts.processed ?? 0), inline: true },
      { name: 'Добавлено', value: String(counts.added ?? 0), inline: true },
      { name: 'Уже было', value: String(counts.existing ?? 0), inline: true },
      { name: 'Не удалось', value: String(counts.failed ?? 0), inline: true }
    );
}

export function trackAddedEmbed(track, { alreadyInPlaylist = false, playlistLabel = 'библиотеку «Хайповый музон»' } = {}) {
  return new EmbedBuilder()
    .setColor(alreadyInPlaylist ? 0xfee75c : 0x57f287)
    .setTitle(alreadyInPlaylist ? 'ℹ️ Трек уже есть в плейлисте' : `✅ Трек добавлен в ${playlistLabel}`)
    .setDescription(`**${trackLabel(track)}**`)
    .setThumbnail(track.thumbnail_url || null);
}

export function trackRemovedEmbed(track, { playlistLabel = 'библиотеки' } = {}) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`🗑️ Трек удалён из ${playlistLabel}`)
    .setDescription(`**${trackLabel(track)}**`);
}

export function voteEmbed({ kind, starterTag, votes, needed, secondsLeft, channelId }) {
  const title = kind === 'start' ? '🔥 Голосование за включение Хайпового музона' : '🛑 Голосование за отключение бота';
  const bar = progressBar(votes, needed, 12);
  return new EmbedBuilder()
    .setColor(kind === 'start' ? HYPE_COLOR : 0x99aab5)
    .setTitle(title)
    .setDescription(`Голосование запустил: **${starterTag}**\nКанал: <#${channelId}>`)
    .addFields(
      { name: 'Прогресс', value: `${bar}  ${votes} / ${needed}` },
      { name: 'Осталось времени', value: `${secondsLeft} сек.` }
    );
}
