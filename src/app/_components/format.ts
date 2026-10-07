export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatEta(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds < 60) return `残り ${Math.max(1, Math.round(seconds))} 秒`;
  return `残り ${Math.ceil(seconds / 60)} 分`;
}

export function joinMeta(parts: readonly (string | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}

// 貼り付けた文字列から URL を拾う。改行・空白・読点で区切られていてよい。
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'、，,]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[)）\]】。.]+$/, "")))];
}
