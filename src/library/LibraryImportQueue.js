import { TrackRepo, normalizeDedupKey } from '../database/TrackRepo.js';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { ImportJobRepo } from '../database/ImportJobRepo.js';
import { resolveTrackRequest, UnresolvableError } from './TrackResolver.js';
import { ResolveError } from './YtDlpResolver.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'LibraryImportQueue' });

// Import runs in the background, off the interaction's request/response
// cycle, so a 500-line TXT file never blocks Discord gateway handling.
// A small worker pool keeps throughput reasonable without hammering the
// search/download source with too many concurrent requests at once.
const CONCURRENCY = 2;

class LibraryImportQueue {
  constructor() {
    this._jobs = new Map(); // jobId -> { items, cursor, result, onProgress, activeWorkers }
  }

  enqueue(job, items, { onProgress, playlistId } = {}) {
    const state = {
      job,
      items,
      playlistId,
      cursor: 0,
      counts: { processed: 0, added: 0, existing: 0, failed: 0 },
      failedItems: [],
      onProgress,
      activeWorkers: 0,
      done: false,
    };
    this._jobs.set(job.id, state);
    ImportJobRepo.setStatus(job.id, 'running');
    this._pump(state);
    return job.id;
  }

  _pump(state) {
    while (state.activeWorkers < CONCURRENCY && state.cursor < state.items.length) {
      const item = state.items[state.cursor];
      state.cursor += 1;
      state.activeWorkers += 1;
      this._processItem(state, item)
        .catch((err) => logger.error('unexpected import item failure', { error: err.message }))
        .finally(() => {
          state.activeWorkers -= 1;
          if (state.cursor >= state.items.length && state.activeWorkers === 0) {
            this._finish(state);
          } else {
            this._pump(state);
          }
        });
    }
  }

  async _processItem(state, item) {
    // Delegate to the same resolver single-track /add uses, so bulk import
    // gets identical behavior: the stored name comes from the download
    // source (not the typed line), and there's a second dedup check against
    // the *resolved* title on top of this pre-download check against what
    // was typed (cheap early skip, avoids a redundant search+download for a
    // line that was imported before under the same typed spelling).
    const dedupKey = normalizeDedupKey(item.artist, item.title);
    const existingTrack = TrackRepo.findByDedupKey(dedupKey);

    if (existingTrack && existingTrack.status === 'ready') {
      // Already downloaded (for this playlist, another playlist, or the
      // library) - reuse the file, just make sure it's linked here too.
      if (!state.playlistId || PlaylistRepo.isLinked(state.playlistId, existingTrack.id)) {
        state.counts.existing += 1;
      } else {
        PlaylistRepo.link(state.playlistId, existingTrack.id);
        state.counts.added += 1;
      }
      state.counts.processed += 1;
      this._reportProgress(state);
      return;
    }

    try {
      await resolveTrackRequest(item.raw, { addedBy: state.job.requested_by, playlistId: state.playlistId });
      state.counts.added += 1;
    } catch (err) {
      const reason =
        err instanceof ResolveError || err instanceof UnresolvableError
          ? err.message
          : `внутренняя ошибка: ${err.message}`;
      logger.warn('track import failed', { line: item.raw, reason });
      TrackRepo.insertFailed({
        artist: item.artist,
        title: item.title,
        dedupKey,
        reason,
        addedBy: state.job.requested_by,
      });
      state.counts.failed += 1;
      state.failedItems.push({ raw: item.raw, reason });
    }

    state.counts.processed += 1;
    this._reportProgress(state);
  }

  _reportProgress(state) {
    ImportJobRepo.updateProgress(state.job.id, state.counts);
    state.onProgress?.(state.counts, state);
  }

  _finish(state) {
    state.done = true;
    ImportJobRepo.setFailedItems(state.job.id, state.failedItems);
    ImportJobRepo.setStatus(state.job.id, 'done');
    this._jobs.delete(state.job.id);
    state.onProgress?.(state.counts, state, true);
  }
}

export const libraryImportQueue = new LibraryImportQueue();
