"use client";

import { AlertCircle, ArrowDown, Check, ChevronRight, Loader2, RotateCw, X } from "lucide-react";
import type { AppError, ProbeEntry, ProbeResult, SaveKind, VideoMeta } from "@/lib/types";
import { KindSwitch } from "./kind-switch";
import { formatDuration, joinMeta } from "./format";
import { Thumb } from "./thumb";

type ListResult = Extract<ProbeResult, { kind: "list" }>;

export type PreviewItem =
  | { key: string; url: string; state: "loading" }
  | { key: string; url: string; state: "error"; error: AppError }
  | { key: string; url: string; state: "video"; meta: VideoMeta; selected: boolean }
  | { key: string; url: string; state: "list"; list: ListResult; selected: readonly string[] };

interface PreviewListProps {
  items: readonly PreviewItem[];
  onToggleVideo: (key: string) => void;
  onToggleEntry: (key: string, entryKey: string) => void;
  onToggleAll: (key: string, select: boolean) => void;
  onOpenList: (url: string) => void;
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onSave: () => void;
  selectedCount: number;
  saving: boolean;
  kind: SaveKind;
  onKindChange: (kind: SaveKind) => void;
}

export function PreviewList(props: PreviewListProps): React.ReactElement {
  const { items, selectedCount, saving } = props;
  const loading = items.some((i) => i.state === "loading");

  return (
    <section aria-labelledby="preview-heading" className="mt-10">
      <div className="mb-3 flex items-baseline justify-between px-1">
        <h2 id="preview-heading" className="text-[13px] font-medium tracking-[0.12em] text-ink-2">
          プレビュー
        </h2>
        <button
          type="button"
          onClick={props.onClear}
          className="text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          すべて取り消す
        </button>
      </div>

      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
        {items.map((item) => (
          <li key={item.key}>
            <PreviewRow item={item} {...props} />
          </li>
        ))}
      </ul>

      <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[28px] border border-line bg-white/95 py-2 pr-2 pl-2 shadow-[0_4px_24px_rgba(0,0,0,0.08)] backdrop-blur sm:flex-nowrap sm:rounded-full">
        <KindSwitch value={props.kind} onChange={props.onKindChange} />
        <p className="min-w-0 flex-1 truncate px-2 text-right text-[13px] text-ink-2">
          {loading ? "読み込み中…" : `${selectedCount} 本を選択中`}
        </p>
        <button
          type="button"
          onClick={props.onSave}
          disabled={selectedCount === 0 || saving}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full whitespace-nowrap bg-ink px-4 text-[14px] font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3"
        >
          {saving ? (
            <Loader2 size={16} strokeWidth={2} className="animate-spin" />
          ) : (
            <ArrowDown size={16} strokeWidth={2} />
          )}
          {selectedCount > 0 ? `${selectedCount} 本を保存` : "保存"}
        </button>
      </div>
    </section>
  );
}

function PreviewRow({ item, ...p }: { item: PreviewItem } & PreviewListProps): React.ReactElement {
  const removeButton = <IconButton label="プレビューから外す" onClick={() => p.onRemove(item.key)} icon={<X size={16} />} />;

  if (item.state === "loading") {
    return (
      <div className="flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
        <div className="h-[45px] w-20 shrink-0 animate-pulse rounded-lg bg-surface sm:h-[63px] sm:w-28" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[14px] text-ink-2">
            <Loader2 size={14} className="animate-spin" />
            読み込み中
          </p>
          <p className="mt-1 truncate text-[13px] text-ink-3">{item.url}</p>
        </div>
        {removeButton}
      </div>
    );
  }

  if (item.state === "error") {
    return (
      <div className="flex items-start gap-3 px-3 py-3 sm:gap-4 sm:px-4">
        <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-ink-3">{item.url}</p>
          <p className="mt-1 text-[14px] text-ink">{item.error.hint ?? item.error.message}</p>
          {item.error.hint && <p className="mt-1 text-[12px] break-all text-ink-3">{item.error.message}</p>}
        </div>
        <IconButton label="もう一度読み込む" onClick={() => p.onRetry(item.key)} icon={<RotateCw size={16} />} />
        {removeButton}
      </div>
    );
  }

  if (item.state === "video") {
    return (
      <div className="flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
        <Checkbox checked={item.selected} onChange={() => p.onToggleVideo(item.key)} label={item.meta.title} />
        <Thumb src={item.meta.thumbnail} className="h-[45px] w-20 sm:h-[63px] sm:w-28" />
        <VideoText meta={item.meta} />
        {removeButton}
      </div>
    );
  }

  const { list, selected } = item;
  const selectable = list.entries.filter((e) => !e.isList);
  const allSelected = selectable.length > 0 && selected.length === selectable.length;
  return (
    <div>
      <div className="flex items-center gap-4 bg-surface/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{list.title}</p>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {joinMeta([list.site, list.uploader, `${list.entries.length}${list.truncated ? " 本以上" : " 本"}`])}
          </p>
        </div>
        {selectable.length > 0 && (
          <button
            type="button"
            onClick={() => p.onToggleAll(item.key, !allSelected)}
            className="shrink-0 rounded-full border border-line bg-white px-3 py-1 text-[13px] text-ink transition-colors hover:bg-surface"
          >
            {allSelected ? "選択を外す" : "すべて選ぶ"}
          </button>
        )}
        {removeButton}
      </div>
      {list.truncated && (
        <p className="px-4 pt-2 text-[12px] text-ink-3">先頭から {list.entries.length} 本だけを表示しています。</p>
      )}
      <ul className="max-h-[440px] divide-y divide-line overflow-y-auto">
        {list.entries.map((entry) => (
          <li key={entry.key}>
            <EntryRow
              entry={entry}
              checked={selected.includes(entry.key)}
              onToggle={() => p.onToggleEntry(item.key, entry.key)}
              onOpen={() => p.onOpenList(entry.url)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntryRow({
  entry,
  checked,
  onToggle,
  onOpen,
}: {
  entry: ProbeEntry;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}): React.ReactElement {
  if (entry.isList) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-surface/60"
      >
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{entry.title}</span>
        <span className="flex shrink-0 items-center gap-0.5 text-[13px] text-ink-2">
          一覧を開く
          <ChevronRight size={14} />
        </span>
      </button>
    );
  }
  return (
    <div className="flex items-center gap-4 px-4 py-2.5">
      <Checkbox checked={checked} onChange={onToggle} label={entry.title} />
      <Thumb src={entry.thumbnail} className="h-[45px] w-20" />
      <VideoText meta={entry} compact />
    </div>
  );
}

function VideoText({ meta, compact = false }: { meta: VideoMeta; compact?: boolean }): React.ReactElement {
  return (
    <div className="min-w-0 flex-1">
      <p className={`line-clamp-2 text-ink ${compact ? "text-[13px]" : "text-[14px] font-medium"}`}>{meta.title}</p>
      <p className="mt-0.5 truncate text-[12px] text-ink-2">
        {joinMeta([meta.site, meta.uploader, formatDuration(meta.duration)])}
      </p>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
        checked ? "border-ink bg-ink text-white" : "border-ink-3 bg-white hover:border-ink"
      }`}
    >
      {checked && <Check size={13} strokeWidth={3} />}
    </button>
  );
}

export function IconButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface hover:text-ink"
    >
      {icon}
    </button>
  );
}
