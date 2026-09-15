import { env } from '../config/env.js';
import { UnresolvableError } from './TrackResolver.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
// Safety valve independent of the caller's own item cap - an album this
// long is unrealistic, so something's gone wrong (e.g. an infinite `next`
// loop) well before this many pages.
const MAX_PAGES = 20;

export function isSpotifyApiConfigured() {
  return Boolean(env.spotifyClientId && env.spotifyClientSecret);
}

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(`${env.spotifyClientId}:${env.spotifyClientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new UnresolvableError(`Не удалось получить токен Spotify API (HTTP ${res.status}).`);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function apiGet(pathOrUrl) {
  const token = await getAccessToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new UnresolvableError(`Spotify API вернул ошибку (HTTP ${res.status}).`);
  }
  return res.json();
}

function tracksToItems(tracks) {
  return tracks
    .filter((t) => t?.name)
    .map((t) => {
      const artist = (t.artists || []).map((a) => a.name).filter(Boolean).join(', ');
      return { raw: artist ? `${artist} - ${t.name}` : t.name, artist, title: t.name };
    });
}

// Client Credentials (no user login) still works fine for album track
// reads - unlike playlists, Spotify hasn't locked this one down. Real
// offset/limit pagination, so unlike the playlist embed-widget fallback
// this genuinely returns the whole thing regardless of size.
export async function fetchAlbumTracksViaApi(albumId, itemLimit) {
  const items = [];
  let path = `/albums/${albumId}/tracks?limit=50&fields=items(name,artists(name)),next`;
  let pages = 0;

  while (path && items.length < itemLimit && pages < MAX_PAGES) {
    const data = await apiGet(path);
    items.push(...tracksToItems(data.items || []));
    path = data.next;
    pages += 1;
  }

  return items.slice(0, itemLimit);
}
