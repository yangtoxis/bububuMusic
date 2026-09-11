import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';

const ffmpegPath = 'ffmpeg'; // apt-installed in the Docker image, NOT the ffmpeg-static npm package

// Wraps a single local library file as a raw PCM stream for @discordjs/voice.
// One instance is spawned per track; it is not reused across tracks.
export class LocalFileSource {
  constructor(track) {
    this.track = track;
    this._process = null;
    this._logger = createLogger({ module: 'LocalFileSource', trackId: track.id });
  }

  createStream() {
    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-i', this.track.file_path,
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    this._process = ffmpeg;

    ffmpeg.stderr.on('data', (chunk) => {
      this._logger.warn('ffmpeg stderr', { message: chunk.toString().slice(0, 300) });
    });
    ffmpeg.on('error', (err) => {
      this._logger.error('ffmpeg process error', { error: err.message });
    });
    ffmpeg.on('close', (code, signal) => {
      if (code !== 0 && code !== null) {
        this._logger.warn('ffmpeg exited non-zero', { code, signal });
      }
    });

    return ffmpeg.stdout;
  }

  destroy() {
    if (this._process && !this._process.killed) {
      this._process.kill('SIGKILL');
    }
  }
}
