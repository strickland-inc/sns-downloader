"use client";

import type { SaveKind } from "@/lib/types";

const OPTIONS: readonly { value: SaveKind; label: string }[] = [
  { value: "video", label: "動画" },
  { value: "both", label: "動画＋文字起こし" },
  { value: "text", label: "文字起こし" },
];

interface KindSwitchProps {
  value: SaveKind;
  onChange: (value: SaveKind) => void;
}

// 何を保存するかの切り替え。選んだものは次回も使う
export function KindSwitch({ value, onChange }: KindSwitchProps): React.ReactElement {
  return (
    <div role="radiogroup" aria-label="保存するもの" className="flex shrink-0 rounded-full bg-surface p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1.5 text-[12px] whitespace-nowrap transition-colors sm:text-[13px] ${
            value === o.value ? "bg-white font-medium text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
