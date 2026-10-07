import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ACTIVE_STATUSES, type JobView, type NewJobInput } from "@/lib/types";
import { YTDLP, childEnv, commonArgs, explainError } from "@/lib/server/ytdlp";

const MAX_PARALLEL = 3;
// 1人が一度に積めるジョブの数。チャンネル全部を一度に積まれて Mac が埋まるのを防ぐ
const MAX_ACTIVE_PER_USER = 50;
// YouTube は途中で 403 を返すことがある。URL を取り直せば通るので、自動でやり直す。
const MAX_ATTEMPTS = 3;
const TRANSIENT_ERROR = /HTTP Error 403|HTTP Error 5\d\d|Connection reset|timed out|IncompleteRead|fragment .* not found/i;
const HISTORY_LIMIT = 500;
// ブラウザが受け取りに来なかったファイルを消すまでの時間
const FILE_TTL_MS = 6 * 60 * 60 * 1000;
// この Mac の空きがこれを下回ったら新しく落とさない
const MIN_FREE_BYTES = 10 * 1024 ** 3;
// 1本の上限。並列で落とす本数ぶんの余白も空き容量の判定に足す
const MAX_FILE_BYTES = 4 * 1024 ** 3;
// 通常のダウンロードに渡したファイルは、ブラウザが受け取ったか分からないので早めに消す
const HANDED_TTL_MS = 60 * 60 * 1000;

const STATE_DIR = join(homedir(), "Library", "Application Support", "SNS-Downloader");
const HISTORY_FILE = join(STATE_DIR, "history.json");
// 保存した MP4 は、ブラウザが取りに来るまでここに置く
export const FILES_ROOT = join(homedir(), "Library", "Caches", "SNS-Downloader", "files");
const TEMP_ROOT = join(tmpdir(), "sns-downloader");

// 保存先で読める名前にする。タイトルは 80 バイトで切り、同名を避けるため ID を付ける。
const OUTPUT_TEMPLATE = "%(title).80B [%(extractor_key)s %(id)s].%(ext)s";

interface Job extends JobView {
  owner: string;
  filePath?: string;
  // この時刻を過ぎた ready のファイルは消す
  fileExpiresAt?: number;
}

interface Store {
  jobs: Map<string, Job>;
  queue: string[];
  children: Map<string, ChildProcess>;
  cancelRequested: Set<string>;
  loaded: boolean;
}

// next dev の再読み込みで状態が消えないよう globalThis に置く
const globalStore = globalThis as typeof globalThis & { __snsDownloader?: Store };
const store: Store = (globalStore.__snsDownloader ??= {
  jobs: new Map(),
  queue: [],
  children: new Map(),
  cancelRequested: new Set(),
  loaded: false,
});

function isActive(job: JobView): boolean {
  return ACTIVE_STATUSES.includes(job.status);
}

function isStoredJob(value: unknown): value is Job {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.owner === "string" &&
    typeof v.url === "string" &&
    typeof v.title === "string" &&
    typeof v.status === "string" &&
    typeof v.createdAt === "number"
  );
}

function loadHistory(): void {
  if (store.loaded) return;
  store.loaded = true;
  try {
    const raw: unknown = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
    if (!Array.isArray(raw)) return;
    for (const item of raw as unknown[]) {
      if (isStoredJob(item) && !isActive(item)) store.jobs.set(item.id, item);
    }
  } catch {
    // 初回起動や壊れたファイルは空の履歴から始める
  }
}

function saveHistory(): void {
  const finished = [...store.jobs.values()]
    .filter((j) => !isActive(j))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, HISTORY_LIMIT);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // 書き込み中に落ちても履歴が途切れないよう、別名に書いてから置き換える
    const tmp = `${HISTORY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(finished, null, 2));
    renameSync(tmp, HISTORY_FILE);
  } catch (e: unknown) {
    console.error("履歴を保存できませんでした", e instanceof Error ? e.message : e);
  }
}

// 持ち主とファイルの絶対パスはブラウザへ渡さない
function toView(job: Job): JobView {
  const view: Partial<Job> = { ...job };
  delete view.filePath;
  delete view.owner;
  delete view.fileExpiresAt;
  return view as JobView;
}

function ownJob(owner: string, id: string): Job | undefined {
  loadHistory();
  const job = store.jobs.get(id);
  return job && job.owner === owner ? job : undefined;
}

export function listJobs(owner: string): JobView[] {
  loadHistory();
  return [...store.jobs.values()]
    .filter((j) => j.owner === owner)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toView);
}

export type CreateResult = { ok: true; jobs: JobView[] } | { ok: false; message: string };

export function createJobs(owner: string, inputs: readonly NewJobInput[]): CreateResult {
  loadHistory();
  const active = [...store.jobs.values()].filter((j) => j.owner === owner && isActive(j)).length;
  if (active + inputs.length > MAX_ACTIVE_PER_USER) {
    return {
      ok: false,
      message: `一度に保存できるのは ${MAX_ACTIVE_PER_USER} 本までです（いま ${active} 本が進行中）`,
    };
  }
  const created = inputs.map((input) => {
    const job: Job = {
      id: randomUUID(),
      owner,
      url: input.url,
      playlistIndex: input.playlistIndex,
      title: input.title,
      uploader: input.uploader,
      site: input.site,
      thumbnail: input.thumbnail,
      duration: input.duration,
      status: "queued",
      createdAt: Date.now(),
    };
    store.jobs.set(job.id, job);
    store.queue.push(job.id);
    return job;
  });
  pump();
  return { ok: true, jobs: created.map(toView) };
}

export function cancelJob(owner: string, id: string): void {
  const job = ownJob(owner, id);
  if (!job || !isActive(job)) return;
  const child = store.children.get(id);
  if (child) {
    store.cancelRequested.add(id);
    killGroup(child);
  } else {
    store.queue = store.queue.filter((q) => q !== id);
    finish(job, { status: "canceled" });
  }
}

function killGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

// サーバーが止まるとき、別のプロセスグループで動く yt-dlp と ffmpeg も止める
export function killAllChildren(): void {
  for (const child of store.children.values()) killGroup(child);
}

export function hasActiveJobs(): boolean {
  return store.children.size > 0 || store.queue.length > 0;
}

function dropFile(job: Job, state: "delivered" | "expired"): void {
  rmSync(join(FILES_ROOT, job.id), { recursive: true, force: true });
  job.filePath = undefined;
  job.fileState = state;
}

export function removeJob(owner: string, id: string): void {
  const job = ownJob(owner, id);
  if (!job) return;
  cancelJob(owner, id);
  dropFile(job, "expired");
  store.jobs.delete(id);
  saveHistory();
}

export function clearFinished(owner: string): void {
  loadHistory();
  for (const job of store.jobs.values()) {
    if (job.owner === owner && !isActive(job) && job.fileState !== "ready") {
      dropFile(job, "expired");
      store.jobs.delete(job.id);
    }
  }
  saveHistory();
}

// ブラウザが受け取りに来たファイル。持ち主のジョブで、まだ消していないものだけ返す
export function readyFile(owner: string, id: string): { path: string; name: string; size: number } | null {
  const job = ownJob(owner, id);
  if (!job || job.status !== "done" || job.fileState !== "ready" || !job.filePath) return null;
  if (!existsSync(job.filePath)) return null;
  return { path: job.filePath, name: basename(job.filePath), size: statSync(job.filePath).size };
}

// ブラウザが保存先へ書き終えたら、この Mac からは消す
export function markDelivered(owner: string, id: string): void {
  const job = ownJob(owner, id);
  if (!job || job.fileState !== "ready") return;
  dropFile(job, "delivered");
  saveHistory();
}

// 通常のダウンロードに渡したファイルは 1 時間で消す
export function markHanded(owner: string, id: string): void {
  const job = ownJob(owner, id);
  if (!job || job.fileState !== "ready") return;
  job.fileExpiresAt = Math.min(job.fileExpiresAt ?? Number.POSITIVE_INFINITY, Date.now() + HANDED_TTL_MS);
  saveHistory();
}

// 受け取られずに残ったファイルと、どのジョブにも属さないフォルダを消す
export function sweepFiles(): void {
  loadHistory();
  const now = Date.now();
  let changed = false;
  for (const job of store.jobs.values()) {
    const expiresAt = job.fileExpiresAt ?? (job.finishedAt ?? 0) + FILE_TTL_MS;
    if (job.fileState === "ready" && now > expiresAt) {
      dropFile(job, "expired");
      changed = true;
    }
  }
  try {
    for (const name of readdirSync(FILES_ROOT)) {
      const job = store.jobs.get(name);
      if (!job || (job.fileState !== "ready" && !isActive(job))) {
        rmSync(join(FILES_ROOT, name), { recursive: true, force: true });
      }
    }
  } catch {
    // まだ一度も保存していなければフォルダが無い
  }
  try {
    for (const name of readdirSync(TEMP_ROOT)) {
      const job = store.jobs.get(name);
      if (!job || !isActive(job)) rmSync(join(TEMP_ROOT, name), { recursive: true, force: true });
    }
  } catch {
    // 一時フォルダがまだ無い
  }
  if (changed) saveHistory();
}

function pump(): void {
  while (store.children.size < MAX_PARALLEL && store.queue.length > 0) {
    const id = store.queue.shift();
    const job = id ? store.jobs.get(id) : undefined;
    if (job && job.status === "queued") start(job);
  }
}

function finish(job: Job, patch: Partial<Job>): void {
  // spawn に失敗すると error と close の両方が来る。2回目は無視する
  if (!isActive(job)) return;
  Object.assign(job, patch, { finishedAt: Date.now(), speed: undefined, eta: undefined });
  store.children.delete(job.id);
  store.cancelRequested.delete(job.id);
  saveHistory();
  pump();
}

function numOrUndef(s: string | undefined): number | undefined {
  if (!s || s === "NA" || s === "None") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function freeBytes(dir: string): number {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function downloadArgs(job: Job, outDir: string, tempDir: string): string[] {
  const args = [
    ...commonArgs(),
    // QuickTime と iPhone でそのまま再生できる H.264 + AAC を優先する。
    // -S は並べ替えなので、H.264 が無いサイトでは他の形式で落ちる。
    "-f", "bv*+ba/b",
    "-S", "vcodec:h264,res,acodec:m4a",
    "--merge-output-format", "mp4",
    "--remux-video", "mp4",
    "--embed-metadata",
    "--max-filesize", String(MAX_FILE_BYTES),
    // 更新日時を投稿日にしない。保存先が ~/Downloads の自動整理のように
    // 更新日時で古いものを消す場所でも、保存した日から数えさせる。
    "--no-mtime",
    "--newline",
    "--progress",
    "--progress-template",
    "download:SNSDL|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.vcodec)s",
    "--print", "after_move:SNSFILE|%(filepath)s",
    "--no-simulate",
    "-P", `home:${outDir}`,
    "-P", `temp:${tempDir}`,
    "-o", OUTPUT_TEMPLATE,
  ];
  if (job.playlistIndex) {
    args.push("--yes-playlist", "--playlist-items", String(job.playlistIndex));
  } else {
    args.push("--no-playlist");
  }
  args.push("--", job.url);
  return args;
}

function start(job: Job, attempt = 1): void {
  const outDir = join(FILES_ROOT, job.id);
  const tempDir = join(TEMP_ROOT, job.id);
  try {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
  } catch (e: unknown) {
    finish(job, { status: "error", error: explainError(`ERROR: ${e instanceof Error ? e.message : String(e)}`) });
    return;
  }
  if (freeBytes(outDir) < MIN_FREE_BYTES + store.children.size * MAX_FILE_BYTES) {
    finish(job, {
      status: "error",
      error: { message: "保存用の Mac の空き容量が足りません", hint: "管理者に連絡してください。" },
    });
    return;
  }
  job.status = "running";
  job.percent = 0;
  job.error = undefined;

  // 取り消すとき、結合中の ffmpeg まで止められるよう、プロセスグループを分ける
  const child = spawn(YTDLP, downloadArgs(job, outDir, tempDir), { env: childEnv(), detached: true });
  store.children.set(job.id, child);

  let stderr = "";
  let buffer = "";
  let tooLarge = false;
  // 日本語がチャンクの境目で割れないよう、デコードはストリームに任せる
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.includes("larger than max-filesize")) tooLarge = true;
      handleLine(job, line.trim());
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000);
  });

  const cleanupTemp = (): void => rmSync(tempDir, { recursive: true, force: true });
  const cleanupAll = (): void => {
    cleanupTemp();
    rmSync(outDir, { recursive: true, force: true });
  };

  child.on("error", (e) => {
    cleanupAll();
    finish(job, { status: "error", error: explainError(`ERROR: ${e.message}`) });
  });
  child.on("close", (code) => {
    if (buffer) handleLine(job, buffer.trim());
    if (store.cancelRequested.has(job.id)) {
      cleanupAll();
      finish(job, { status: "canceled" });
      return;
    }
    // 一時ファイルを残したままやり直すと、yt-dlp は続きから落とす
    if (code !== 0 && attempt < MAX_ATTEMPTS && TRANSIENT_ERROR.test(stderr)) {
      console.warn(`[${job.id}] ${attempt} 回目が失敗したのでやり直します`);
      setTimeout(() => {
        if (store.cancelRequested.has(job.id)) {
          cleanupAll();
          finish(job, { status: "canceled" });
        } else {
          start(job, attempt + 1);
        }
      }, 1500 * attempt);
      return;
    }
    cleanupTemp();
    if (code === 0 && job.filePath && existsSync(job.filePath)) {
      finish(job, {
        status: "done",
        percent: 100,
        fileName: basename(job.filePath),
        fileSize: statSync(job.filePath).size,
        fileState: "ready",
        fileExpiresAt: Date.now() + FILE_TTL_MS,
      });
      return;
    }
    rmSync(outDir, { recursive: true, force: true });
    finish(job, {
      status: "error",
      error: tooLarge
        ? { message: "4GB を超える動画は保存できません" }
        : explainError(stderr || "ダウンロードが途中で止まりました"),
    });
  });
}

function handleLine(job: Job, line: string): void {
  if (line.startsWith("SNSFILE|")) {
    job.filePath = line.slice("SNSFILE|".length);
    return;
  }
  if (!line.startsWith("SNSDL|")) return;
  const [, status, done, total, estimate, speed, eta, vcodec] = line.split("|");
  const totalBytes = numOrUndef(total) ?? numOrUndef(estimate);
  const doneBytes = numOrUndef(done);
  job.stream = vcodec === "none" ? "audio" : "video";
  if (status === "finished") {
    // 映像と音声を落とし終えたあと、MP4 への結合が終わるまでの間
    job.status = "finishing";
    job.percent = 100;
    job.speed = undefined;
    job.eta = undefined;
    return;
  }
  job.status = "running";
  job.percent =
    totalBytes && doneBytes !== undefined
      ? Math.min(100, (doneBytes / totalBytes) * 100)
      : undefined;
  job.speed = numOrUndef(speed);
  job.eta = numOrUndef(eta);
}
