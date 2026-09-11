export function formatDuration(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '—:—';
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function trackLabel(track) {
  if (!track) return 'Неизвестный трек';
  return `${track.artist || 'Неизвестен'} — ${track.title}`;
}

export function progressBar(current, total, size = 16) {
  if (!total || total <= 0) return '▬'.repeat(size);
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}
