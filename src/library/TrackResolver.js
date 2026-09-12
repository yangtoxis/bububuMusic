import { spawn } from 'node:child_process';
import { TrackRepo, normalizeDedupKey } from '../database/TrackRepo.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { resolveAndDownloadTrack } from './YtDlpResolver.js';
import { splitArtistTitle } from './splitArtistTitle.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'TrackResolver' });

const YOUTUBE_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/))([\w-]{11})/i;
const SPOTIFY_URL_RE = /open\.spotify\.com\/(?:intl-\w+\/)?track\//i;
const YANDEX_URL_RE = /music\.yandex\.(ru|com|by|kz|uz)\/album\/\d+\/track\/\d+/i;
const SOUNDCLOUD_URL_RE = /soundcloud\.com\/[^/?#]+\/(?!sets\/)[^/?#]+/i;
const URL_RE = /^https?:\/\//i;

// Counterintuitively, a modern browser-spoofed UA makes Spotify serve its
// client-rendered app shell (no OG tags at all) - it only serves the
// prerendered, crawler-friendly HTML (with og:title/og:description) to
// requests that DON'T look like a real browser. A plain, self-identifying
// UA works reliably for Spotify, Yandex Music and SoundCloud alike.
export const BOT_UA = 'Mozilla/5.0 (compatible; HypovyMuzonBot/1.0; +https://discord.com)';

export class UnresolvableError extends Error {}

function extractYoutubeId(text) {
  return text.match(YOUTUBE_ID_RE)?.[1] ?? null;
}

// Spotify/Yandex Music pages carry "og:description" as "Artist · Album · ..."
// (Spotify, middle dot) or "Artist • Трек • Year" (Yandex, bullet) - the
// artist is reliably the first segment either way.
export function splitArtistFromDescription(description) {
  if (!description) return '';
  const [first] = description.split(/\s*[•·]\s*/);
  return (first || '').trim();
}

const FETCH_TIMEOUT_SECONDS = 20;
// Marks the end of the response body in curl's stdout so the HTTP status
// (appended after via -w) can be split back off reliably.
const STATUS_MARKER = '\n__HYPOVYMUZON_STATUS__';

// Shells out to curl instead of using Node's own fetch(). Some of these
// services fingerprint the TLS/HTTP client and specifically block Node's
// undici handshake while letting curl's through from the exact same IP -
// confirmed in production against Yandex Music (identical request, same
// host: 403 from fetch(), 200 from curl). Mirrors the same spawn pattern
// YtDlpResolver.js already uses for yt-dlp.
function curlGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['-H', `${key}: ${value}`]);
    const args = [
      '-sL',
      '--max-time', String(FETCH_TIMEOUT_SECONDS),
      '-w', STATUS_MARKER + '%{http_code}',
      ...headerArgs,
      url,
    ];

    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString().slice(0, 300);
    });
    child.on('error', (err) => {
      reject(new UnresolvableError(`Не удалось запустить curl: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new UnresolvableError(`Не удалось открыть ссылку: curl завершился с кодом ${code} (${stderr.trim().slice(0, 200)})`));
        return;
      }
      const markerIndex = stdout.lastIndexOf(STATUS_MARKER);
      if (markerIndex === -1) {
        reject(new UnresolvableError('Не удалось открыть ссылку: неожиданный ответ curl.'));
        return;
      }
      const body = stdout.slice(0, markerIndex);
      const status = Number.parseInt(stdout.slice(markerIndex + STATUS_MARKER.length), 10);
      resolve({ status, body });
    });
  });
}

export async function fetchHtml(url) {
  const { status, body } = await curlGet(url, { 'User-Agent': BOT_UA });

  if (status === 429 || status === 403) {
    throw new UnresolvableError(
      'Источник временно ограничил доступ с сервера бота (слишком много запросов подряд). Обычно это снимается само через некоторое время — попробуй ещё раз чуть позже.'
    );
  }
  if (status < 200 || status >= 300) {
    throw new UnresolvableError(`Сервер вернул ошибку (HTTP ${status}) при открытии ссылки.`);
  }
  return body;
}

// Some of these sites occasionally answer 200 with a stripped client-shell
// page - no og tags, no embedded data - instead of the real server-
// rendered content, seemingly at random (more often under sustained
// request volume from the same IP, but not reliably tied to any one
// signal we can detect up front). Retrying a couple of times with a short
// pause is cheap insurance and usually gets the real page on a later try
// instead of failing outright on what's actually a transient hiccup.
export async function fetchHtmlWithRetry(url, isValid, { attempts = 3, delayMs = 2500 } = {}) {
  let html = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    html = await fetchHtml(url);
    if (isValid(html)) return html;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return html;
}

export async function fetchOgMeta(url, sourceLabel) {
  const html = await fetchHtmlWithRetry(url, (h) => /<meta property="og:title"/.test(h));
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

// SoundCloud doesn't reliably carry artist in og:description, but its
// <title> tag follows a stable "Stream {title} by {artist} | ..." pattern.
export async function fetchSoundCloudMeta(url) {
  const html = await fetchHtmlWithRetry(url, (h) => /<title>Stream .+? by .+? \|/.test(h));
  const match = html.match(/<title>Stream (.+?) by (.+?) \|/);
  if (!match) {
    throw new UnresolvableError('Не удалось найти название трека на странице SoundCloud.');
  }
  const title = decodeHtmlEntities(match[1]);
  const artist = decodeHtmlEntities(match[2]);
  // Some SoundCloud uploads redundantly repeat the artist inside the track
  // title itself ("Alan Walker - Welcome To Walkerworld" uploaded under
  // artist "Alan Walker") - drop that duplicate prefix when present.
  const prefixRe = new RegExp(`^${artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—]\\s*`, 'i');
  return { title: title.replace(prefixRe, '').trim() || title, artist };
}

export function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Pure track resolution - no playlist concept here at all. Downloads only
// if there's no existing dedup match; returns the track row either way.
async function downloadAndStore({ artist, title, rawQuery, addedBy }) {
  const result = await resolveAndDownloadTrack({ artist, title, rawQuery }, {});
  // The name shown is always the actual metadata from the download source
  // (the real YouTube video title/uploader), not whatever text was used to
  // search for it - search queries are often imprecise or inconsistently
  // typed, the source's own title is the reliable one.
  const finalArtist = result.resolvedArtist || artist || 'Неизвестен';
  const finalTitle = result.resolvedTitle || title;
  const dedupKey = normalizeDedupKey(finalArtist, finalTitle);

  // The resolved title can turn out to match something already downloaded
  // even when our upfront guess didn't (e.g. a raw YouTube URL).
  const existingByKey = TrackRepo.findByDedupKey(dedupKey);
  if (existingByKey && existingByKey.status === 'ready') {
    return { track: existingByKey, wasNew: false };
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
  });
  return { track, wasNew: true };
}

async function resolveBySearch({ artist, title, addedBy }) {
  const dedupKey = normalizeDedupKey(artist, title);
  const existing = TrackRepo.findByDedupKey(dedupKey);
  if (existing && existing.status === 'ready') {
    return { track: existing, wasNew: false };
  }
  return downloadAndStore({ artist, title, addedBy });
}

/**
 * Resolves a single track request - a free-text query, an "Artist - Title"
 * line, or a YouTube/Spotify/Yandex Music link - into a downloaded track,
 * only downloading if it (or an equivalent dedup match) isn't already on
 * disk, then links it into the given playlist (null = resolve/cache only,
 * don't add to any playlist - used by /add-queue). Spotify and Yandex Music
 * are read only for their public page metadata (artist/title) - the actual
 * audio always comes from YouTube via yt-dlp's normal extractor, never from
 * a DRM-protected source.
 */
export async function resolveTrackRequest(input, { addedBy, playlistId = null } = {}) {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new UnresolvableError('Пустой запрос.');

  let result;
  const youtubeId = extractYoutubeId(trimmed);
  if (youtubeId) {
    const existing = TrackRepo.findBySourceId('youtube', youtubeId);
    result = existing ? { track: existing, wasNew: false } : await downloadAndStore({ rawQuery: trimmed, addedBy });
  } else if (SPOTIFY_URL_RE.test(trimmed)) {
    const meta = await fetchOgMeta(trimmed, 'Spotify');
    result = await resolveBySearch({ artist: meta.artist, title: meta.title, addedBy });
  } else if (YANDEX_URL_RE.test(trimmed)) {
    const meta = await fetchOgMeta(trimmed, 'Яндекс Музыки');
    result = await resolveBySearch({ artist: meta.artist, title: meta.title, addedBy });
  } else if (SOUNDCLOUD_URL_RE.test(trimmed)) {
    const meta = await fetchSoundCloudMeta(trimmed);
    result = await resolveBySearch({ artist: meta.artist, title: meta.title, addedBy });
  } else if (URL_RE.test(trimmed)) {
    throw new UnresolvableError(
      'Эта ссылка не поддерживается. Сейчас можно добавлять по ссылке на YouTube, Spotify, Яндекс Музыку или SoundCloud — либо просто названием трека.'
    );
  } else {
    const split = splitArtistTitle(trimmed);
    result = await resolveBySearch({ artist: split?.artist ?? '', title: split?.title ?? trimmed, addedBy });
  }

  let alreadyInPlaylist = false;
  if (playlistId) {
    alreadyInPlaylist = PlaylistRepo.isLinked(playlistId, result.track.id);
    PlaylistRepo.link(playlistId, result.track.id);
  }

  return { track: result.track, wasNew: result.wasNew, alreadyInPlaylist };
}
