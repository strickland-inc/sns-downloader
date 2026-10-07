import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppError, ProbeEntry, ProbeResult } from "@/lib/types";

// launchd から起動すると PATH に Homebrew が入らないので、場所を自分で探す。
// yt-dlp は YouTube の解析に deno を使うため、子プロセスの PATH にも足す。
const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

function findBin(name: string): string {
  for (const dir of BIN_DIRS) {
    // Mac の外のパスなのでビルドの依存追跡から外す
    const path = join(/*turbopackIgnore: true*/ dir, name);
    if (existsSync(/*turbopackIgnore: true*/ path)) return path;
  }
  return name;
}

export const YTDLP = process.env.YTDLP_PATH ?? findBin("yt-dlp");
export const FFMPEG = process.env.FFMPEG_PATH ?? findBin("ffmpeg");
export const BREW = findBin("brew");

// 一覧（チャンネルなど）で読む本数の上限。全件読むと数分かかる。
const LIST_LIMIT = 300;

export function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [...BIN_DIRS, process.env.PATH ?? ""].join(":"),
    LANG: "ja_JP.UTF-8",
    PYTHONIOENCODING: "utf-8",
  };
}

export function commonArgs(): string[] {
  return ["--ignore-config", "--ffmpeg-location", FFMPEG];
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: childEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\nERROR: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function ytdlpVersion(): Promise<string | null> {
  const r = await run(YTDLP, ["--version"], 30_000);
  return r.code === 0 ? r.stdout.trim() : null;
}

// ---- 解析 ------------------------------------------------------------------

type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isJson(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SITE_NAMES: Record<string, string> = {
  Youtube: "YouTube",
  YoutubeTab: "YouTube",
  Instagram: "Instagram",
  InstagramStory: "Instagram",
  TikTok: "TikTok",
  TikTokUser: "TikTok",
  Twitter: "X",
  Facebook: "Facebook",
  Vimeo: "Vimeo",
  Niconico: "ニコニコ動画",
};

export function siteName(extractorKey: string | undefined): string {
  if (!extractorKey) return "Web";
  return SITE_NAMES[extractorKey] ?? extractorKey;
}

function pickThumbnail(info: Json): string | undefined {
  const direct = str(info.thumbnail);
  if (direct) return direct;
  const list = info.thumbnails;
  if (!Array.isArray(list)) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const t: unknown = list[i];
    if (isJson(t) && str(t.url)) return str(t.url);
  }
  return undefined;
}

function looksLikeList(entry: Json): boolean {
  if (entry._type === "playlist") return true;
  const ie = str(entry.ie_key) ?? "";
  return /Tab$|Playlist|Channel|User$/.test(ie);
}

function toEntries(parentUrl: string, info: Json, site: string): ProbeEntry[] {
  const raw = Array.isArray(info.entries) ? info.entries : [];
  const entries: ProbeEntry[] = [];
  raw.forEach((value: unknown, i: number) => {
    if (!isJson(value)) return;
    const index = i + 1;
    const entryIe = str(value.ie_key) ?? str(value.extractor_key);
    // --flat-playlist で返る参照（_type: url）は個別 URL を持つ。
    // Instagram のカルーセルのように中身まで解決済みの項目は、url が
    // 動画ファイルそのものを指すので使わず、親 URL と番号で落とす。
    const isRef = value._type === "url" || value._type === "url_transparent";
    const ownUrl = isRef ? str(value.url) : str(value.webpage_url);
    const usable = ownUrl && ownUrl !== parentUrl ? ownUrl : undefined;
    entries.push({
      key: `${index}:${str(value.id) ?? ""}`,
      url: usable ?? parentUrl,
      playlistIndex: usable ? undefined : index,
      title: str(value.title) ?? `${index} 本目`,
      uploader: str(value.uploader) ?? str(value.channel),
      site: entryIe ? siteName(entryIe) : site,
      thumbnail: pickThumbnail(value),
      duration: num(value.duration),
      isList: looksLikeList(value),
    });
  });
  return entries;
}

export async function probe(
  url: string,
): Promise<{ ok: true; result: ProbeResult } | { ok: false; error: AppError }> {
  const args = [
    ...commonArgs(),
    "--dump-single-json",
    "--flat-playlist",
    "--no-playlist",
    "--playlist-items",
    `1:${LIST_LIMIT}`,
    "--",
    url,
  ];
  const r = await run(YTDLP, args, 90_000);
  if (r.code !== 0) return { ok: false, error: explainError(r.stderr) };

  let info: unknown;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: explainError(r.stderr || "解析結果を読めませんでした") };
  }
  if (!isJson(info)) {
    return { ok: false, error: { message: "解析結果を読めませんでした" } };
  }

  const site = siteName(str(info.extractor_key));
  if (info._type === "playlist") {
    const entries = toEntries(url, info, site);
    // 1本だけの一覧（動画が1本だけの投稿など）は動画として扱う
    if (entries.length === 1 && !entries[0].isList) {
      const only = entries[0];
      return {
        ok: true,
        result: {
          kind: "video",
          url: only.playlistIndex ? url : only.url,
          title: only.title,
          uploader: only.uploader ?? str(info.uploader),
          site,
          thumbnail: only.thumbnail ?? pickThumbnail(info),
          duration: only.duration,
        },
      };
    }
    return {
      ok: true,
      result: {
        kind: "list",
        url,
        title: str(info.title) ?? url,
        uploader: str(info.uploader) ?? str(info.channel),
        site,
        entries,
        truncated: entries.length >= LIST_LIMIT,
      },
    };
  }

  return {
    ok: true,
    result: {
      kind: "video",
      url: str(info.webpage_url) ?? url,
      title: str(info.title) ?? url,
      uploader: str(info.uploader) ?? str(info.channel),
      site,
      thumbnail: pickThumbnail(info),
      duration: num(info.duration),
    },
  };
}

// ---- エラーの説明 ----------------------------------------------------------

const HINTS: readonly { pattern: RegExp; hint: string }[] = [
  {
    pattern: /ENOENT|not found: yt-dlp|spawn .*yt-dlp/i,
    hint: "サーバーに yt-dlp が見つかりません。管理者に連絡してください。",
  },
  {
    pattern: /Unsupported URL/i,
    hint: "このページには対応していません。動画の投稿ページの URL を貼ってください。",
  },
  {
    pattern: /No video formats found|There is no video in this post/i,
    hint: "動画が見つかりませんでした。画像や文章だけの投稿の可能性があります。",
  },
  {
    pattern: /IP address is blocked/i,
    hint: "TikTok がこの回線からの取得を断りました。時間をおいて試してください。",
  },
  {
    pattern: /Sign in to confirm|not a bot/i,
    hint: "YouTube が確認を求めています。時間をおいて試してください。",
  },
  {
    pattern: /login|log in|sign in|cookies|rate-?limit|private|members-only|Requested content is not available/i,
    hint: "非公開か、ログインしないと見られない投稿です。公開中の投稿の URL か確かめてください。",
  },
  {
    pattern: /Video unavailable|has been removed|does not exist|HTTP Error 404/i,
    hint: "動画が削除されたか、URL が間違っています。",
  },
  {
    pattern: /HTTP Error 403/i,
    hint: "サイトに途中で断られました（3回やり直しました）。少し時間をおいて再試行してください。",
  },
  {
    pattern: /Unable to extract|nsig|signature|Precondition check failed/i,
    hint: "サイトの仕様が変わった可能性があります。yt-dlp は毎日自動で更新しているので、翌日に試すか、管理者に連絡してください。",
  },
  {
    pattern: /timed out|Connection reset|Temporary failure in name resolution|Network is unreachable/i,
    hint: "ネットワークにつながりません。接続を確かめてください。",
  },
];

export function explainError(stderr: string): AppError {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => l.startsWith("ERROR:"));
  const message = (errorLine ?? lines.at(-1) ?? "不明なエラー")
    .replace(/^ERROR:\s*/, "")
    .slice(0, 400);
  const hint = HINTS.find((h) => h.pattern.test(message))?.hint;
  return { message, hint };
}
