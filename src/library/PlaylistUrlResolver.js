import { spawn } from 'node:child_process';
import {
  fetchHtmlWithRetry,
  fetchOgMeta,
  fetchSoundCloudMeta,
  fetchYandexApi,
  yandexTrackToItem,
  splitArtistFromDescription,
  decodeHtmlEntities,
  UnresolvableError,
} from './TrackResolver.js';
import { splitArtistTitle } from './splitArtistTitle.js';
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
// Only the explicit "/playlist?list=..." shape - a plain "watch?v=...&list=..."
// link is a single video that happens to sit in some playlist, and stays a
// single-track add (handled by TrackResolver.js) rather than surprising
// someone by importing the whole thing.
const YOUTUBE_PLAYLIST_RE = /(?:music\.)?youtube\.com\/playlist\?[^\s#]*\blist=[\w-]+/i;

// Upper bound so one runaway link can't queue an unbounded background job
// - well above any playlist size we actually expect to see in practice.
const PLAYLIST_ITEM_LIMIT = 500;

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
  if (YOUTUBE_PLAYLIST_RE.test(trimmed)) {
    return { platform: 'youtube', label: 'YouTube', url: trimmed };
  }
  return null;
}

const SPOTIFY_ENTITY_RE = /open\.spotify\.com\/(?:intl-\w+\/)?(playlist|album)\/([a-zA-Z0-9]+)/i;

// Spotify's own embeddable widget (the iframe you get from "Share > Embed
// playlist") ships every track's title+artist directly in a __NEXT_DATA__
// JSON blob on first load - one request for the whole playlist instead of
// one og:meta fetch per track (the old approach below), which is both far
// fewer requests and immune to any single track's page failing to load.
// Confirmed against a real ~1000-track playlist that this widget itself
// caps at under 100 entries with no offset/cursor exposed anywhere in the
// response - there's no way to page past that from this endpoint. Below
// that size (the overwhelming majority of real playlists) this returns the
// complete list.
async function resolveSpotifyPlaylistViaEmbed(url) {
  const match = url.match(SPOTIFY_ENTITY_RE);
  if (!match) throw new UnresolvableError('Не удалось распознать эту ссылку на Spotify.');
  const [, type, id] = match;

  const html = await fetchHtmlWithRetry(
    `https://open.spotify.com/embed/${type}/${id}`,
    (h) => h.includes('__NEXT_DATA__')
  );
  const dataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!dataMatch) throw new UnresolvableError('Не удалось получить данные плейлиста Spotify.');

  let data;
  try {
    data = JSON.parse(dataMatch[1]);
  } catch {
    throw new UnresolvableError('Не удалось разобрать данные плейлиста Spotify.');
  }

  const trackList = data?.props?.pageProps?.state?.data?.entity?.trackList;
  if (!Array.isArray(trackList) || trackList.length === 0) {
    throw new UnresolvableError('Не удалось найти треки в этом плейлисте/альбоме Spotify.');
  }

  if (trackList.length >= 95) {
    logger.warn('spotify embed widget likely truncated a large playlist - no pagination available here', {
      url,
      count: trackList.length,
    });
  }

  return trackList.slice(0, PLAYLIST_ITEM_LIMIT).map((t) => {
    const title = decodeHtmlEntities(t.title || '').trim();
    const artist = decodeHtmlEntities(t.subtitle || '').trim();
    return { raw: artist ? `${artist} - ${title}` : title, artist, title };
  });
}

// Old approach, kept as a fallback if Spotify ever changes the embed
// widget's markup: scrape "music:song" meta tags off the regular playlist
// page, then fetch each track's own page individually. Much slower (N+1
// requests) and caps out far lower in practice.
async function resolveSpotifyPlaylistViaOgMeta(url) {
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

async function resolveSpotifyPlaylist(url) {
  try {
    return await resolveSpotifyPlaylistViaEmbed(url);
  } catch (err) {
    logger.warn('spotify embed widget unavailable, falling back to og:meta scraping', { error: err.message, url });
    return resolveSpotifyPlaylistViaOgMeta(url);
  }
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

async function resolveYandexPlaylistViaApi(url) {
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

// api.music.yandex.* (the API path above) is geo-blocked with HTTP 451
// from at least some server locations, even though the regular site isn't
// - confirmed in production (works from a dev machine, 451 from the actual
// VPS). Falls back to scraping the regular page when the API isn't
// reachable from wherever this process happens to be running.
function extractYandexTracksFromHydrationState(html) {
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

async function resolveYandexPlaylistViaScraping(url) {
  const html = await fetchHtmlWithRetry(url, (h) => /<meta property="og:title"/.test(h));
  const ldMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);

  if (ldMatch) {
    let data;
    try {
      data = JSON.parse(ldMatch[1]);
    } catch {
      data = null;
    }
    const ldTracks = Array.isArray(data?.tracks) ? data.tracks : [];
    if (ldTracks.length > 0) {
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
  }

  const items = extractYandexTracksFromHydrationState(html).slice(0, PLAYLIST_ITEM_LIMIT);
  if (items.length === 0) {
    throw new UnresolvableError('Не удалось найти треки на этой странице Яндекс Музыки.');
  }
  return items;
}

async function resolveYandexPlaylist(url) {
  try {
    return await resolveYandexPlaylistViaApi(url);
  } catch (err) {
    logger.warn('yandex api unavailable for playlist, falling back to page scraping', { error: err.message, url });
    return resolveYandexPlaylistViaScraping(url);
  }
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

// Unlike every other platform here, YouTube IS the actual download source -
// so instead of turning each entry into an "Artist - Title" search query
// (which would just make YtDlpResolver search YouTube again for a worse
// match), `raw` is the real watch URL. TrackResolver.resolveTrackRequest
// recognizes that immediately and downloads that exact video - no re-search
// round-trip, and no risk of matching a different upload of the same song.
async function resolveYoutubePlaylist(url) {
  const stdout = await runYtDlpFlatPlaylist(url, 30_000);
  const items = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.title && (entry.webpage_url || entry.id))
    .map((entry) => {
      const videoUrl = entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`;
      const split = splitArtistTitle(entry.title);
      return { raw: videoUrl, artist: split?.artist ?? '', title: split?.title ?? entry.title };
    })
    .slice(0, PLAYLIST_ITEM_LIMIT);

  if (items.length === 0) {
    throw new UnresolvableError('Не удалось найти видео в этом плейлисте YouTube.');
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
  if (platform === 'youtube') return resolveYoutubePlaylist(url);
  throw new UnresolvableError('Неизвестная платформа плейлиста.');
}
