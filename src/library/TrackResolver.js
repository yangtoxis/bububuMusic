import { TrackRepo, normalizeDedupKey } from '../database/TrackRepo.js';
import { resolveAndDownloadTrack } from './YtDlpResolver.js';
import { splitArtistTitle } from './splitArtistTitle.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'TrackResolver' });

const YOUTUBE_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/))([\w-]{11})/i;
const SPOTIFY_URL_RE = /open\.spotify\.com\//i;
const YANDEX_URL_RE = /music\.yandex\.(ru|com|by|kz|uz)\//i;
const URL_RE = /^https?:\/\//i;

// Counterintuitively, a modern browser-spoofed UA makes Spotify serve its
// client-rendered app shell (no OG tags at all) - it only serves the
// prerendered, crawler-friendly HTML (with og:title/og:description) to
// requests that DON'T look like a real browser. A plain, self-identifying
// UA works reliably for both Spotify and Yandex Music.
const BOT_UA = 'Mozilla/5.0 (compatible; HypovyMuzonBot/1.0; +https://discord.com)';

export class UnresolvableError extends Error {}

function extractYoutubeId(text) {
  return text.match(YOUTUBE_ID_RE)?.[1] ?? null;
}

// Spotify/Yandex Music pages carry "og:description" as "Artist · Album · ..."
// (Spotify, middle dot) or "Artist • Трек • Year" (Yandex, bullet) - the
// artist is reliably the first segment either way.
function splitArtistFromDescription(description) {
  if (!description) return '';
  const [first] = description.split(/\s*[•·]\s*/);
  return (first || '').trim();
}

async function fetchOgMeta(url, sourceLabel) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': BOT_UA } });
  } catch (err) {
    throw new UnresolvableError(`Не удалось открыть ссылку на ${sourceLabel}: ${err.message}`);
  }
  if (!res.ok) {
    throw new UnresolvableError(`${sourceLabel} вернул ошибку (HTTP ${res.status}) при открытии ссылки.`);
  }
  const html = await res.text();
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const description = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
  if (!title) {
    throw new UnresolvableError(`Не удалось найти название трека на странице ${sourceLabel}.`);
  }
  return {
    title: decodeHtmlEntities(title),
    artist: splitArtistFromDescription(decodeHtmlEntities(description || '')),
  };
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Reuses an already-downloaded track, promoting it to the permanent
// library (never demoting) if this particular request asked for that -
// e.g. a track first pulled in via /add-queue later gets a proper /add.
function reuseExisting(existing, inLibrary) {
  if (!existing) return null;
  if (inLibrary && !existing.in_library) {
    TrackRepo.setInLibrary(existing.id, true);
    return TrackRepo.getById(existing.id);
  }
  return existing;
}

async function downloadAndStore({ artist, title, rawQuery, addedBy, inLibrary }) {
  const result = await resolveAndDownloadTrack({ artist, title, rawQuery }, {});
  // The name shown in the library is always the actual metadata from the
  // download source (the real YouTube video title/uploader), not whatever
  // text was used to search for it - search queries are often imprecise or
  // inconsistently typed, the source's own title is the reliable one.
  const finalArtist = result.resolvedArtist || artist || 'Неизвестен';
  const finalTitle = result.resolvedTitle || title;
  const dedupKey = normalizeDedupKey(finalArtist, finalTitle);

  // The resolved title can turn out to match something already in the
  // library even when our upfront guess didn't (e.g. a raw YouTube URL).
  const existingByKey = TrackRepo.findByDedupKey(dedupKey);
  if (existingByKey && existingByKey.status === 'ready') {
    return { track: reuseExisting(existingByKey, inLibrary), wasNew: false };
  }

  const track = TrackRepo.insertReady({
    artist: finalArtist,
    title: finalTitle,
    dedupKey,
    filePath: result.filePath,
    source: result.source,
    sourceId: result.sourceId,
    durationSeconds: result.durationSeconds,
    thumbnailUrl: result.thumbnailUrl,
    addedBy,
    inLibrary,
  });
  return { track, wasNew: true };
}

async function resolveBySearch({ artist, title, addedBy, inLibrary }) {
  const dedupKey = normalizeDedupKey(artist, title);
  const existing = TrackRepo.findByDedupKey(dedupKey);
  if (existing && existing.status === 'ready') {
    return { track: reuseExisting(existing, inLibrary), wasNew: false };
  }
  return downloadAndStore({ artist, title, addedBy, inLibrary });
}

/**
 * Resolves a single track request - a free-text query, an "Artist - Title"
 * line, or a YouTube/Spotify/Yandex Music link - into a library track,
 * downloading it only if it (or an equivalent dedup match) isn't already
 * on disk. Spotify and Yandex Music are read only for their public page
 * metadata (artist/title) - the actual audio always comes from YouTube via
 * yt-dlp's normal extractor, never from a DRM-protected source.
 */
export async function resolveTrackRequest(input, { addedBy, inLibrary = true } = {}) {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new UnresolvableError('Пустой запрос.');

  const youtubeId = extractYoutubeId(trimmed);
  if (youtubeId) {
    const existing = TrackRepo.findBySourceId('youtube', youtubeId);
    if (existing) return { track: reuseExisting(existing, inLibrary), wasNew: false };
    return downloadAndStore({ rawQuery: trimmed, addedBy, inLibrary });
  }

  if (SPOTIFY_URL_RE.test(trimmed)) {
    const meta = await fetchOgMeta(trimmed, 'Spotify');
    return resolveBySearch({ artist: meta.artist, title: meta.title, addedBy, inLibrary });
  }

  if (YANDEX_URL_RE.test(trimmed)) {
    const meta = await fetchOgMeta(trimmed, 'Яндекс Музыки');
    return resolveBySearch({ artist: meta.artist, title: meta.title, addedBy, inLibrary });
  }

  if (URL_RE.test(trimmed)) {
    throw new UnresolvableError(
      'Эта ссылка не поддерживается. Сейчас можно добавлять по ссылке на YouTube, Spotify или Яндекс Музыку — либо просто названием трека.'
    );
  }

  const split = splitArtistTitle(trimmed);
  const artist = split?.artist ?? '';
  const title = split?.title ?? trimmed;
  return resolveBySearch({ artist, title, addedBy, inLibrary });
}
