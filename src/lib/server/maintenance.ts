import { hasActiveJobs, killAllChildren, sweepFiles } from "@/lib/server/jobs";
import { BREW, run, ytdlpVersion } from "@/lib/server/ytdlp";

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 30 * 60 * 1000;

// サイトの仕様変更で古い yt-dlp は動かなくなる。社員が気づく前に毎日更新する。
// 保存中に入れ替えると実行中の yt-dlp が壊れるので、空いているときだけ行う。
async function updateYtdlp(): Promise<void> {
  if (hasActiveJobs()) {
    setTimeout(() => void updateYtdlp(), UPDATE_RETRY_MS);
    return;
  }
  const before = await ytdlpVersion();
  const r = await run(BREW, ["upgrade", "yt-dlp"], 10 * 60 * 1000);
  const after = await ytdlpVersion();
  if (r.code !== 0 && !/already installed|latest/i.test(r.stdout + r.stderr)) {
    console.error(`[maintenance] yt-dlp を更新できませんでした: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`);
  } else if (before !== after) {
    console.log(`[maintenance] yt-dlp を ${before} から ${after} に更新しました`);
  }
  setTimeout(() => void updateYtdlp(), UPDATE_INTERVAL_MS);
}

export function startMaintenance(): void {
  const g = globalThis as typeof globalThis & { __snsMaintenance?: boolean };
  if (g.__snsMaintenance) return;
  g.__snsMaintenance = true;
  // exit は同期で走るので、SIGTERM の扱いを Next から奪わずに子プロセスを止められる
  process.on("exit", killAllChildren);
  sweepFiles();
  setInterval(sweepFiles, SWEEP_INTERVAL_MS).unref();
  // 起動直後の負荷を避けて1分後に1回目
  setTimeout(() => void updateYtdlp(), 60 * 1000).unref();
}
