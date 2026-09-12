import { spawn } from 'node:child_process';
import {
  fetchHtml,
  fetchHtmlWithRetry,
  fetchOgMeta,
  fetchSoundCloudMeta,
  splitArtistFromDescription,
  decodeHtmlEntities,
  UnresolvableError,
} from './TrackResolver.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'PlaylistUrlResolver' });

// Full playlist/album links (as opposed to single-track links, handled by
// TrackResolver.js) - detected separately so the caller can route to a
// bulk import instead of a single-track add.
const SPOTIFY_PLAYLIST_RE = /open\.spotify\.com\/(?:intl-\w+\/)?playlist\/[a-zA-Z0-9]+/i;
const SPOTIFY_ALBUM_RE = /open\.spotify\.com\/(?:intl-\w+\/)?album\/[a-zA-Z0-9]+/i;
const YANDEX_ALBUM_ONLY_RE = /music\.yandex\.(ru|com|by|kz|uz)\/album\/\d+\/?(?:[?#]|$)/i;
// Covers both a named user playlist (/users/<name>/playlists/<id>) and a
// personal share link like "Мне нравится" (/playlists/<uuid>, no /users/).
const YANDEX_PLAYLIST_RE = /music\.yandex\.(ru|com|by|kz|uz)\/(?:users\/[^/]+\/)?playlists\/[\w.-]+/i;
const SOUNDCLOUD_SET_RE = /soundcloud\.com\/[^/?#]+\/sets\/[^/?#]+/i;

// Public scraping only exposes the first page of a large playlist either
// way (Spotify's own og:meta caps around here) - stay well within that
// rather than hammering dozens of individual track pages.
const PLAYLIST_ITEM_LIMIT = 60;

export function detectPlaylistUrl(text) {
  const trimmed = (text || '').trim();
  if (SPOTIFY_PLAYLIST_RE.test(trimmed) || SPOTIFY_ALBUM_RE.test(trimmed)) {
    return { platform: 'spotify', label: 'Spotify', url: trimmed };
  }
  if (YANDEX_ALBUM_ONLY_RE.test(trimmed) || YANDEX_PLAYLIST_RE.test(trimmed)) {
    return { platform: 'yandex', label: 'Яндекс Музыки', url: trimmed };
  }
  if (SOUNDCLOUD_SET_RE.test(trimmed)) {
    return { platform: 'soundcloud', label: 'SoundCloud', url: trimmed };
  }
  return null;
}

async function resolveSpotifyPlaylist(url) {
  const html = await fetchHtmlWithRetry(url, (h) => h.includes('name="music:song"'));
  const trackUrls = [...html.matchAll(/name="music:song" content="(https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+)"/g)]
    .map((m) => m[1])
    .slice(0, PLAYLIST_ITEM_LIMIT);
  if (trackUrls.length === 0) {
    throw new UnresolvableError('Не удалось найти треки в этом плейлисте/альбоме Spotify.');
  }

  const items = [];
  for (const trackUrl of trackUrls) {
    try {
      const meta = await fetchOgMeta(trackUrl, 'Spotify');
      items.push({ raw: `${meta.artist} - ${meta.title}`.trim(), artist: meta.artist, title: meta.title });
    } catch (err) {
      logger.warn('skipped one spotify playlist track', { trackUrl, error: err.message });
    }
  }
  return items;
}

// Only album pages (and some curated playlists) embed the full track list
// in their schema.org JSON-LD block. Large/personal playlists (e.g. "Мне
// нравится" liked-tracks share links) only put summary info there
// (numTracks, no `tracks` array) - the actual per-track data instead lives
// scattered through the page's Next.js hydration state, one object per
// track carrying its own "title" plus a "realId"/"artists" a bit further
// along. There's no clean single JSON blob to parse (React streams it in
// pieces), so this walks each "realId" occurrence and pulls the nearest
// preceding title / following artist name out of the surrounding text
// instead of a full parse.
function extractTracksFromHydrationState(html) {
  const items = [];
  const realIdRe = /"realId":"\d+"/g;
  let match;
  while ((match = realIdRe.exec(html))) {
    const before = html.slice(Math.max(0, match.index - 600), match.index);
    const titleMatches = [...before.matchAll(/"title":"((?:[^"\\]|\\.)*)"/g)];
    const titleRaw = titleMatches.at(-1)?.[1];
    if (!titleRaw) continue;

    const after = html.slice(match.index, match.index + 500);
    const artistRaw = after.match(/"artists":\[\{"id":"[^"]*","name":"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';

    const title = decodeHtmlEntities(JSON.parse(`"${titleRaw}"`));
    const artist = artistRaw ? decodeHtmlEntities(JSON.parse(`"${artistRaw}"`)) : '';
    items.push({ raw: artist ? `${artist} - ${title}` : title, artist, title });
  }
  return items;
}

async function resolveYandexPlaylist(url) {
  // og:title is present on every real (server-rendered) Yandex Music page
  // regardless of type - the most reliable single signal that this isn't
  // the stripped client-shell variant.
  const html = await fetchHtmlWithRetry(url, (h) => /<meta property="og:title"/.test(h));
  const ldMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (!ldMatch) {
    throw new UnresolvableError('Не удалось найти список треков на странице Яндекс Музыки.');
  }

  let data;
  try {
    data = JSON.parse(ldMatch[1]);
  } catch {
    throw new UnresolvableError('Не удалось разобрать данные страницы Яндекс Музыки.');
  }

  const ldTracks = Array.isArray(data.tracks) ? data.tracks : [];

  if (ldTracks.length > 0) {
    // A single-artist album's page-level og:description reliably names the
    // artist ("Artist • Альбом • Год") - reuse it for every track. A
    // user-curated playlist can mix artists, so we deliberately don't guess
    // one there and let each track resolve by title alone.
    let sharedArtist = '';
    if (data['@type'] === 'MusicAlbum') {
      const ogDescription = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
      sharedArtist = splitArtistFromDescription(decodeHtmlEntities(ogDescription || ''));
    }

    return ldTracks
      .slice(0, PLAYLIST_ITEM_LIMIT)
      .map((t) => decodeHtmlEntities(t.name || '').trim())
      .filter(Boolean)
      .map((title) => ({
        raw: sharedArtist ? `${sharedArtist} - ${title}` : title,
        artist: sharedArtist,
        title,
      }));
  }

  const items = extractTracksFromHydrationState(html).slice(0, PLAYLIST_ITEM_LIMIT);
  if (items.length === 0) {
    throw new UnresolvableError('Не удалось найти треки на этой странице Яндекс Музыки.');
  }
  return items;
}

function runYtDlpFlatPlaylist(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', ['--no-warnings', '--flat-playlist', '-j', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString().slice(0, 300);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new UnresolvableError(`не удалось запустить yt-dlp: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new UnresolvableError('превышено время ожидания при получении списка треков'));
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        reject(new UnresolvableError(`не удалось получить список треков SoundCloud: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// yt-dlp's --flat-playlist listing avoids resolving each track's actual
// stream (which is what trips SoundCloud's "This video is DRM protected"
// on some tracks) - it only lists entry URLs. Metadata for each still
// comes from scraping that track's own page, same as a single-track add.
async function resolveSoundCloudPlaylist(url) {
  const stdout = await runYtDlpFlatPlaylist(url, 30_000);
  const trackUrls = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        // Some entries only carry an api-v2.soundcloud.com/tracks/ID URL in
        // one of these fields (needs auth, 401s) - only the plain
        // soundcloud.com/user/track-slug page is scrapable.
        const candidates = [parsed.webpage_url, parsed.url].filter(Boolean);
        return candidates.find((u) => /^https?:\/\/soundcloud\.com\//i.test(u)) ?? null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, PLAYLIST_ITEM_LIMIT);

  if (trackUrls.length === 0) {
    throw new UnresolvableError('Не удалось найти треки в этом плейлисте SoundCloud.');
  }

  const items = [];
  for (const trackUrl of trackUrls) {
    try {
      const meta = await fetchSoundCloudMeta(trackUrl);
      items.push({ raw: `${meta.artist} - ${meta.title}`, artist: meta.artist, title: meta.title });
    } catch (err) {
      logger.warn('skipped one soundcloud playlist track', { trackUrl, error: err.message });
    }
  }
  return items;
}

/**
 * Resolves a playlist/album URL into a list of { raw, artist, title } items
 * - the same shape parseTrackList.js produces for TXT lines - ready to feed
 * into the bulk import pipeline. Never downloads audio itself; that still
 * goes through the normal per-item YouTube resolution.
 */
export async function resolvePlaylistUrlItems({ platform, url }) {
  if (platform === 'spotify') return resolveSpotifyPlaylist(url);
  if (platform === 'yandex') return resolveYandexPlaylist(url);
  if (platform === 'soundcloud') return resolveSoundCloudPlaylist(url);
  throw new UnresolvableError('Неизвестная платформа плейлиста.');
}
