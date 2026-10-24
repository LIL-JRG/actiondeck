export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** 83.25 → "1:23.2" */
export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** 475 → "7:55", 3725 → "1:02:05" */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

export function describeClip(info: { width: number; height: number; fps: number; codec: string; bitDepth: number }) {
  const codec = info.codec === "hevc" ? "H.265" : info.codec === "h264" ? "H.264" : info.codec.toUpperCase();
  return `${info.width}×${info.height} · ${Math.round(info.fps * 100) / 100} fps · ${codec} ${info.bitDepth}-bit`;
}
