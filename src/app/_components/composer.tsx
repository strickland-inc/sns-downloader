"use client";

import { ArrowDown, Loader2 } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { extractUrls } from "./format";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}

export function Composer({ value, onChange, onSubmit, busy }: ComposerProps): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const count = extractUrls(value).length;

  // 貼り付けた行数に合わせて高さを伸ばす
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 空のときは測らない。CSS の読み込み前に測ると、折り返した placeholder の高さになる
    if (value === "") {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (count > 0) onSubmit();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="rounded-[28px] border border-line bg-white px-5 pt-4 pb-3 shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-shadow focus-within:shadow-[0_6px_28px_rgba(0,0,0,0.10)]"
    >
      <label htmlFor="urls" className="sr-only">
        動画の URL
      </label>
      <textarea
        id="urls"
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        autoFocus
        spellCheck={false}
        placeholder="動画の URL を貼り付け（複数可）"
        className="block max-h-[280px] min-h-7 w-full resize-none bg-transparent text-[15px] leading-7 text-ink outline-none placeholder:text-ink-3"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[13px] text-ink-3">
          {count > 0 ? `${count} 件の URL` : "YouTube・Instagram・TikTok・X など"}
        </p>
        <button
          type="submit"
          disabled={count === 0 || busy}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full whitespace-nowrap bg-ink px-4 text-[14px] font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3"
        >
          {busy ? (
            <Loader2 size={16} strokeWidth={2} className="animate-spin" />
          ) : (
            <ArrowDown size={16} strokeWidth={2} />
          )}
          ダウンロード
        </button>
      </div>
    </form>
  );
}
