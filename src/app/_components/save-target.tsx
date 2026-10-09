"use client";

import { FolderOpen } from "lucide-react";
import type { LocalSaveApi } from "./use-local-save";

// 入力欄の下に出す保存先の表示と変更。フォルダを選ばなければブラウザのダウンロードフォルダに入る
export function SaveTarget({
  save,
  onError,
}: {
  save: LocalSaveApi;
  onError: (message: string) => void;
}): React.ReactElement | null {
  if (save.mode === "unknown") return null;

  const current = save.folderName ?? "ダウンロード（ブラウザの既定）";

  return (
    <div className="mt-3 flex flex-col items-center gap-2">
      <p className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
        <FolderOpen size={14} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">
          保存先 <span className="font-medium text-ink">{current}</span>
        </span>
        {save.mode === "folder" && (
          <>
            <button
              type="button"
              onClick={() =>
                void save.chooseFolder().then((r) => {
                  if (r.message) onError(r.message);
                })
              }
              className="rounded-full px-2 py-0.5 text-ink-3 underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {save.folderName ? "変更" : "別のフォルダを選ぶ"}
            </button>
            {save.folderName && (
              <button
                type="button"
                onClick={save.resetFolder}
                className="rounded-full px-2 py-0.5 text-ink-3 underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                既定に戻す
              </button>
            )}
          </>
        )}
      </p>
      {save.needsPermission && (
        <div className="flex items-center gap-3 rounded-full border border-line py-1.5 pr-1.5 pl-4 text-[13px] text-ink-2">
          <span>「{save.folderName}」への書き込みを許可してください</span>
          <button
            type="button"
            onClick={() => void save.grant()}
            className="rounded-full bg-ink px-3 py-1 text-[13px] font-medium text-white transition-opacity hover:opacity-85"
          >
            許可する
          </button>
          <button type="button" onClick={save.resetFolder} className="pr-2 text-ink-3 hover:text-ink">
            既定に戻す
          </button>
        </div>
      )}
    </div>
  );
}
