import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { env } from '../config/env.js';
import { splitArtistTitle } from './splitArtistTitle.js';
import { cleanTitle } from './cleanTitle.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'YtDlpResolver' });

class ResolveError extends Error {}

// yt-dlp's own reported `duration` is the *original* video length - the
// SponsorBlock removal below is a download-time post-process that yt-dlp
// doesn't reflect back into that field, so it'd be stale/wrong on any
// trimmed track. Ask ffprobe what actually ended up on disk instead.
function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const seconds = Number.parseFloat(stdout.trim());
        resolve(Number.isFinite(seconds) ? Math.round(seconds) : null);
      }
    );
  });
}

function runYtDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      stderr += chunk.toString().slice(0, 500);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ResolveError(`не удалось запустить yt-dlp: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ResolveError('превышено время ожидания yt-dlp'));
        return;
      }
      if (code !== 0) {
        reject(new ResolveError(`yt-dlp завершился с кодом ${code}: ${stderr.trim().slice(0, 300) || 'нет вывода'}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Resolves and downloads audio via yt-dlp - either from an explicit query
 * built from {artist, title} (searched as ytsearch1:...) or from a raw
 * positional argument (rawQuery) that yt-dlp treats as a direct URL when it
 * looks like one. Only ever pulls audio through yt-dlp's normal, non-DRM
 * download path (YouTube), never from a DRM-protected source directly.
 */
export async function resolveAndDownloadTrack({ artist, title, rawQuery }, { timeoutSeconds } = {}) {
  const query = (rawQuery ?? [artist, title].filter(Boolean).join(' ')).trim();
  if (!query) throw new ResolveError('пустой запрос');

  const timeoutMs = (timeoutSeconds ?? env.importTrackTimeoutSeconds) * 1000;
  const outputTemplate = `${env.libraryDir}/%(id)s.%(ext)s`;

  const args = [
    '--no-playlist',
    '--default-search', 'ytsearch1',
    '-f', 'bestaudio/best',
    '--no-warnings',
    '--print-json',
    '--no-simulate',
    '--no-progress',
    // Cuts out the non-song parts of a music video using SponsorBlock's
    // crowd-sourced segment data before it's ever written to disk - a
    // skit/dialogue intro, an outro, a "like and subscribe" plug, etc.
    // "music_offtopic" is SponsorBlock's category specifically for
    // non-music sections of a video tagged as music. Videos with no
    // SponsorBlock data just download unmodified - this never fails the
    // download itself.
    '--sponsorblock-remove', 'music_offtopic,intro,outro,selfpromo,interaction,sponsor,preview',
    '-o', outputTemplate,
    query,
  ];

  const stdout = await runYtDlp(args, timeoutMs);
  const jsonLine = stdout.trim().split('\n').filter(Boolean).pop();
  if (!jsonLine) {
    throw new ResolveError('источник не найден');
  }

  let info;
  try {
    info = JSON.parse(jsonLine);
  } catch {
    throw new ResolveError('не удалось разобрать ответ yt-dlp');
  }

  const filePath =
    info?.requested_downloads?.[0]?.filepath ||
    info?.filepath ||
    info?._filename ||
    `${env.libraryDir}/${info.id}.${info.ext}`;

  if (!fs.existsSync(filePath)) {
    throw new ResolveError('скачанный файл не найден на диске');
  }

  // YouTube's own Content-ID artist/track fields are almost never populated
  // (checked empirically - even official-artist uploads come back with
  // artist/track/album all null), so they're not a usable source. The
  // uploader/channel name is also unreliable - it's often a repost/
  // compilation channel unrelated to the actual artist. What's actually
  // reliable is the video's own title, which nearly always follows an
  // "Artist - Title" convention on real music uploads - split it and prefer
  // that over the channel name whenever it parses.
  const cleanedFullTitle = cleanTitle(info.title);
  const titleSplit = splitArtistTitle(cleanedFullTitle);
  const actualDuration = await probeDurationSeconds(filePath);

  return {
    filePath,
    source: 'youtube',
    sourceId: info.id ?? null,
    durationSeconds: actualDuration ?? (info.duration ? Math.round(info.duration) : null),
    thumbnailUrl: info.thumbnail ?? null,
    resolvedTitle: info.track || titleSplit?.title || cleanedFullTitle || title,
    resolvedArtist: info.artist || titleSplit?.artist || info.uploader || artist,
  };
}

export { ResolveError };
