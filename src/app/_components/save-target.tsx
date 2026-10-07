"use client";

import { FolderOpen } from "lucide-react";
import type { LocalSaveApi } from "./use-local-save";

// 入力欄の下に出す保存先の表示と変更
export function SaveTarget({
  save,
  onError,
}: {
  save: LocalSaveApi;
  onError: (message: string) => void;
}): React.ReactElement | null {
  if (save.mode === "unknown") return null;

  if (save.mode === "browser") {
    return (
      <p className="mt-3 flex items-center justify-center gap-1.5 text-[13px] text-ink-3">
        <FolderOpen size={14} strokeWidth={1.75} />
        保存先はブラウザのダウンロードフォルダです
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() =>
          void save.chooseFolder().then((r) => {
            if (r.message) onError(r.message);
          })
        }
        className="inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[13px] text-ink-2 transition-colors hover:bg-surface hover:text-ink"
      >
        <FolderOpen size={14} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">
          保存先 <span className="font-medium text-ink">{save.folderName ?? "未選択"}</span>
        </span>
        <span className="shrink-0 text-ink-3">{save.folderName ? "変更" : "選ぶ"}</span>
      </button>
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
        </div>
      )}
    </div>
  );
}
