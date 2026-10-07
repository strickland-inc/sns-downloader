"use client";

import { Film } from "lucide-react";
import { useState } from "react";

interface ThumbProps {
  src?: string;
  className?: string;
}

// Instagram などのサムネイルは外部から読めないことがあるので、失敗したら枠だけ出す
export function Thumb({ src, className = "" }: ThumbProps): React.ReactElement {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-lg bg-surface ${className}`}>
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-ink-3">
          <Film size={18} strokeWidth={1.75} />
        </div>
      )}
    </div>
  );
}
