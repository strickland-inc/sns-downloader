// ブラウザとサーバーの両方から読む型。サーバー専用の処理はここに置かない。

export interface VideoMeta {
  title: string;
  uploader?: string;
  site: string;
  thumbnail?: string;
  duration?: number;
}

export interface ProbeEntry extends VideoMeta {
  key: string;
  // ダウンロードに使う URL。カルーセル投稿のように個別 URL が無いものは
  // 親の URL と playlistIndex で指定する。
  url: string;
  playlistIndex?: number;
  // チャンネルのタブ（動画・ショート）のように、開くとさらに一覧になるもの
  isList: boolean;
}

export type ProbeResult =
  | ({ kind: "video"; url: string } & VideoMeta)
  | {
      kind: "list";
      url: string;
      title: string;
      uploader?: string;
      site: string;
      entries: ProbeEntry[];
      truncated: boolean;
    };

export interface AppError {
  message: string;
  hint?: string;
}

export type JobStatus =
  | "queued"
  | "running"
  | "finishing"
  | "done"
  | "error"
  | "canceled";

export interface JobView extends VideoMeta {
  id: string;
  url: string;
  playlistIndex?: number;
  status: JobStatus;
  stream?: "video" | "audio";
  percent?: number;
  speed?: number;
  eta?: number;
  fileName?: string;
  fileSize?: number;
  // サーバーに置いた MP4 の状態。ready の間だけブラウザが取りに来られる
  fileState?: "ready" | "delivered" | "expired";
  error?: AppError;
  createdAt: number;
  finishedAt?: number;
}

export interface NewJobInput extends VideoMeta {
  url: string;
  playlistIndex?: number;
}

export const ACTIVE_STATUSES: readonly JobStatus[] = [
  "queued",
  "running",
  "finishing",
];
