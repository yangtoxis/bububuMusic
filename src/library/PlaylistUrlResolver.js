import { spawn } from 'node:child_process';
import {
  fetchHtmlWithRetry,
  fetchOgMeta,
  fetchSoundCloudMeta,
  fetchYandexApi,
  yandexTrackToItem,
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

// Component extractors for the three Yandex Music URL shapes that reach
// here - checked in this order since a named user playlist URL also
// contains "/playlists/<id>" and would otherwise match the share-link
// pattern too.
const YANDEX_ALBUM_ID_RE = /music\.yandex\.(?:ru|com|by|kz|uz)\/album\/(\d+)/i;
const YANDEX_USER_PLAYLIST_RE = /music\.yandex\.(?:ru|com|by|kz|uz)\/users\/([^/]+)\/playlists\/(\d+)/i;
const YANDEX_SHARE_PLAYLIST_RE = /music\.yandex\.(?:ru|com|by|kz|uz)\/playlists\/([\w.-]+)/i;

function toItem(track, fallbackArtist) {
  const { artist, title } = yandexTrackToItem(track, fallbackArtist);
  return { raw: artist ? `${artist} - ${title}` : title, artist, title };
}

async function resolveYandexPlaylist(url) {
  const albumMatch = url.match(YANDEX_ALBUM_ID_RE);
  if (albumMatch) {
    const album = await fetchYandexApi(`albums/${albumMatch[1]}/with-tracks`);
    const albumArtist = (album.artists || []).map((a) => a.name).filter(Boolean).join(', ');
    const tracks = (album.volumes || []).flat();
    if (tracks.length === 0) {
      throw new UnresolvableError('Не удалось найти треки в этом альбоме Яндекс Музыки.');
    }
    return tracks.slice(0, PLAYLIST_ITEM_LIMIT).map((t) => toItem(t, albumArtist));
  }

  const userPlaylistMatch = url.match(YANDEX_USER_PLAYLIST_RE);
  const sharePlaylistMatch = url.match(YANDEX_SHARE_PLAYLIST_RE);
  const apiPath = userPlaylistMatch
    ? `users/${userPlaylistMatch[1]}/playlists/${userPlaylistMatch[2]}`
    : sharePlaylistMatch
      ? `playlist/${sharePlaylistMatch[1]}`
      : null;
  if (!apiPath) {
    throw new UnresolvableError('Не удалось распознать эту ссылку на Яндекс Музыку.');
  }

  const playlist = await fetchYandexApi(apiPath);
  const entries = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  if (entries.length === 0) {
    throw new UnresolvableError('Не удалось найти треки в этом плейлисте Яндекс Музыки.');
  }
  return entries.slice(0, PLAYLIST_ITEM_LIMIT).map((entry) => toItem(entry.track || entry));
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
