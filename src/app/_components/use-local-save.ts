"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobView } from "@/lib/types";
import { api } from "./api";
import {
  canPickFolder,
  describeWriteError,
  handToBrowser,
  hasPermission,
  loadFolder,
  pickFolder,
  writeToFolder,
  type DirectoryHandle,
} from "./save-folder";

export type LocalSave =
  | { phase: "writing"; written: number }
  | { phase: "saved"; folder: string; name: string }
  | { phase: "handed" }
  | { phase: "error"; message: string };

// このブラウザで処理済みのジョブ。再読み込みで二重に保存しないよう残す。
// handed は通常のダウンロードに渡したもの、saved はフォルダへ書いたがサーバーへの通知に失敗したもの
const HANDED_KEY = "sns-downloader:handed";
const SAVED_KEY = "sns-downloader:saved";
const PROGRESS_INTERVAL_MS = 250;

function readIds(key: string): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function addId(key: string, id: string): void {
  const ids = readIds(key);
  ids.add(id);
  try {
    localStorage.setItem(key, JSON.stringify([...ids].slice(-500)));
  } catch {
    // プライベートブラウズなどで書けなくても保存自体は続ける
  }
}

export interface LocalSaveApi {
  mode: "folder" | "browser" | "unknown";
  folderName: string | null;
  needsPermission: boolean;
  local: Readonly<Record<string, LocalSave>>;
  chooseFolder: () => Promise<{ ok: boolean; message?: string }>;
  prepare: () => Promise<{ ok: boolean; message?: string }>;
  grant: () => Promise<void>;
  retry: (id: string) => void;
}

export function useLocalSave(jobs: readonly JobView[], onDelivered: () => void): LocalSaveApi {
  const [mode, setMode] = useState<LocalSaveApi["mode"]>("unknown");
  const [handle, setHandle] = useState<DirectoryHandle | null>(null);
  const [granted, setGranted] = useState(false);
  const [local, setLocal] = useState<Record<string, LocalSave>>({});
  const [retryTick, setRetryTick] = useState(0);
  const busy = useRef(false);
  const attempted = useRef(new Set<string>());

  // 初回だけ、ブラウザの対応と前回選んだフォルダを調べる
  useEffect(() => {
    const supported = canPickFolder();
    void loadFolder().then(async (h) => {
      setMode(supported ? "folder" : "browser");
      setHandle(h);
      if (h) setGranted(await hasPermission(h, false));
    });
  }, []);

  const patch = useCallback((id: string, value: LocalSave) => {
    setLocal((cur) => ({ ...cur, [id]: value }));
  }, []);

  const chooseFolder = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const picked = await pickFolder();
    if (!picked.ok) return { ok: false, message: picked.message };
    setHandle(picked.handle);
    const ok = await hasPermission(picked.handle, true);
    setGranted(ok);
    return { ok };
  }, []);

  // 「保存」を押したときに呼ぶ。フォルダ未選択なら選ばせ、書き込みの許可も取る
  const prepare = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    if (mode !== "folder") return { ok: true };
    if (!handle) return chooseFolder();
    const ok = await hasPermission(handle, true);
    setGranted(ok);
    return { ok };
  }, [mode, handle, chooseFolder]);

  const grant = useCallback(async () => {
    if (handle) setGranted(await hasPermission(handle, true));
  }, [handle]);

  const retry = useCallback((id: string) => {
    attempted.current.delete(id);
    setRetryTick((n) => n + 1);
    setLocal((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);

  const hasReady = jobs.some((j) => j.status === "done" && j.fileState === "ready");

  useEffect(() => {
    const pending = jobs.filter(
      (j) => j.status === "done" && j.fileState === "ready" && !attempted.current.has(j.id),
    );
    if (busy.current || pending.length === 0 || mode === "unknown") return;

    // 前回フォルダへ書いたのに通知が届かなかったものは、書き直さず通知だけ送る
    const savedBefore = readIds(SAVED_KEY);
    const resend = pending.filter((j) => savedBefore.has(j.id));
    for (const job of resend) {
      attempted.current.add(job.id);
      void api.delivered(job.id);
    }
    const fresh = pending.filter((j) => !savedBefore.has(j.id));
    if (fresh.length === 0) return;

    if (mode === "browser") {
      const handed = readIds(HANDED_KEY);
      for (const job of fresh) {
        attempted.current.add(job.id);
        if (!handed.has(job.id)) {
          addId(HANDED_KEY, job.id);
          handToBrowser(api.fileUrl(job.id));
          void api.handed(job.id);
        }
        patch(job.id, { phase: "handed" });
      }
      return;
    }

    if (!handle || !granted) return;
    busy.current = true;
    void (async () => {
      // 1本ずつ書く。並べて書くとディスクとネットワークを取り合う
      for (const job of fresh) {
        attempted.current.add(job.id);
        patch(job.id, { phase: "writing", written: 0 });
        let lastPaint = 0;
        try {
          const res = await fetch(api.fileUrl(job.id), { cache: "no-store" });
          if (!res.ok) {
            throw new Error(res.status === 404 ? "サーバー上のファイルが削除されていました" : `受け取りに失敗しました（${res.status}）`);
          }
          const { name, written } = await writeToFolder(handle, res, job.fileName ?? `${job.id}.mp4`, (n) => {
            // 1チャンクごとに描画すると大きな動画で何万回も再描画するので間引く
            const now = performance.now();
            if (now - lastPaint < PROGRESS_INTERVAL_MS) return;
            lastPaint = now;
            patch(job.id, { phase: "writing", written: n });
          });
          if (job.fileSize !== undefined && written !== job.fileSize) {
            await handle.removeEntry(name).catch(() => undefined);
            throw new Error("途中で通信が切れました。もう一度お試しください");
          }
          patch(job.id, { phase: "saved", folder: handle.name, name });
          const d = await api.delivered(job.id);
          if (!d.ok) addId(SAVED_KEY, job.id);
        } catch (e: unknown) {
          const { message, permissionLost } = describeWriteError(e);
          if (permissionLost) setGranted(false);
          patch(job.id, { phase: "error", message });
        }
      }
      busy.current = false;
      onDelivered();
    })();
  }, [jobs, retryTick, mode, handle, granted, patch, onDelivered]);

  return {
    mode,
    folderName: handle?.name ?? null,
    needsPermission: mode === "folder" && Boolean(handle) && !granted && hasReady,
    local,
    chooseFolder,
    prepare,
    grant,
    retry,
  };
}
