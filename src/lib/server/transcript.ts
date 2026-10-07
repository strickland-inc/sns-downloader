import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { FFMPEG, childEnv } from "@/lib/server/ytdlp";

// macOS の SpeechTranscriber を呼ぶ小さな実行ファイル（scripts/transcribe.swift をビルドしたもの）
export const TRANSCRIBE_BIN = join(/*turbopackIgnore: true*/ process.cwd(), "bin", "transcribe");
const LOCALE = "ja-JP";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export type TranscribeResult =
  | { ok: true; cues: Cue[] }
  | { ok: false; message: string; canceled?: boolean };

// 実行中の子プロセスを渡して、取り消せるようにする
type Track = (child: ChildProcess | null) => void;

function runStep(cmd: string, args: readonly string[], timeoutMs: number, track: Track): Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: childEnv(), detached: true });
    track(child);
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      track(null);
      resolve({ code, stdout, stderr, killed });
    };
    child.on("error", (e) => {
      stderr += e.message;
      done(-1);
    });
    child.on("close", done);
  });
}

function parseCues(stdout: string): Cue[] {
  const cues: Cue[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (
        typeof v === "object" && v !== null &&
        "start" in v && "end" in v && "text" in v &&
        typeof v.start === "number" && typeof v.end === "number" && typeof v.text === "string"
      ) {
        cues.push({ start: v.start, end: v.end, text: v.text });
      }
    } catch {
      // 壊れた行は捨てる
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

// 動画か音声のファイルから字幕の区切りを作る。作業ファイルは workDir に置く
export async function transcribe(
  media: string,
  workDir: string,
  durationSec: number | undefined,
  track: Track,
  isCanceled: () => boolean,
): Promise<TranscribeResult> {
  const wav = join(workDir, "audio.wav");
  const extract = await runStep(
    FFMPEG,
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", media, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
    10 * 60 * 1000,
    track,
  );
  if (isCanceled()) return { ok: false, message: "取り消しました", canceled: true };
  if (extract.code !== 0) {
    console.error(`[transcribe] ffmpeg が失敗 code=${extract.code}: ${extract.stderr.trim().slice(-500)}`);
    return { ok: false, message: /does not contain any stream|no audio|Output file .* does not contain/i.test(extract.stderr) ? "音声が入っていない動画です" : "音声を取り出せませんでした" };
  }

  // 16kHz・16bit・モノラルなので 1 秒は 32,000 バイト。0.5 秒に満たない音声は認識に回さない
  if (statSync(wav).size < 44 + 16000) {
    return { ok: false, message: "話し声を聞き取れませんでした（音声がとても短いか空です）" };
  }

  // 認識は音声の長さの 1/4 ほどで終わる。固まったときのために上限を付ける
  const limitMs = (120 + (durationSec ?? 3600) / 2) * 1000;
  const r = await runStep(TRANSCRIBE_BIN, [wav, LOCALE], limitMs, track);
  if (isCanceled()) return { ok: false, message: "取り消しました", canceled: true };
  if (r.code !== 0) console.error(`[transcribe] bin/transcribe が失敗 code=${r.code} killed=${r.killed}: ${r.stderr.trim().slice(-500)}`);
  if (r.killed) return { ok: false, message: "文字起こしが時間内に終わりませんでした" };
  if (r.code === 3) return { ok: false, message: "この Mac に日本語の音声認識が入っていません。管理者に連絡してください" };
  if (r.code !== 0) return { ok: false, message: "文字起こしに失敗しました" };
  const cues = parseCues(r.stdout);
  // 無音でも「あ」のような1〜2文字を返すことがある。それは話し声とみなさない
  const spoken = cues.map((c) => c.text).join("").replace(/[\s。、！？!?.,]/g, "");
  if (spoken.length <= 2) return { ok: false, message: "話し声を聞き取れませんでした（音楽だけの動画など）" };
  return { ok: true, cues };
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: readonly Cue[]): string {
  return cues
    .map((c, i) => {
      // 次の字幕と重なると、プレーヤーによっては2枚同時に出る
      const next = cues[i + 1];
      const end = next && next.start > c.start ? Math.min(c.end, next.start) : c.end;
      return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(end)}\n${c.text}\n`;
    })
    .join("\n");
}

// 読む用のテキスト。字幕の区切りをつなぎ、文の終わり（閉じかっこまで含める）で改行する。
// 句読点が出ないまま長くなったら、字幕の区切りで改行する
const LINE_LIMIT = 80;
export function toText(cues: readonly Cue[]): string {
  const lines: string[] = [];
  let line = "";
  for (const cue of cues) {
    const parts = cue.text.trim().replace(/([。！？!?][」』）)]*)\s*/g, "$1\n").split("\n");
    parts.forEach((part, i) => {
      line += part.trim();
      const closed = i < parts.length - 1;
      if (closed || line.length >= LINE_LIMIT) {
        if (line) lines.push(line);
        line = "";
      }
    });
  }
  if (line) lines.push(line);
  return lines.join("\n") + "\n";
}
