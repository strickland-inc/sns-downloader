"use client";

import { AlertCircle, CheckCircle2, RotateCw, X } from "lucide-react";
import type { JobView } from "@/lib/types";
import { api } from "./api";
import { formatBytes, formatDuration, formatEta, joinMeta } from "./format";
import { IconButton } from "./preview-list";
import { Thumb } from "./thumb";
import type { LocalSave } from "./use-local-save";

interface JobListProps {
  jobs: readonly JobView[];
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (job: JobView) => void;
  onRetrySave: (id: string) => void;
  local: Readonly<Record<string, LocalSave>>;
  onClearFinished: () => void;
}

export function JobList(props: JobListProps): React.ReactElement {
  const { jobs } = props;
  const hasFinished = jobs.some((j) => j.status === "done" || j.status === "error" || j.status === "canceled");

  return (
    <section aria-labelledby="jobs-heading" className="mt-10">
      <div className="mb-3 flex items-baseline justify-between px-1">
        <h2 id="jobs-heading" className="text-[13px] font-medium tracking-[0.12em] text-ink-2">
          ダウンロード
        </h2>
        {hasFinished && (
          <button
            type="button"
            onClick={props.onClearFinished}
            className="text-[13px] text-ink-3 transition-colors hover:text-ink"
          >
            終わったものを一覧から消す
          </button>
        )}
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
        {jobs.map((job) => (
          <li key={job.id} className="flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
            <Thumb src={job.thumbnail} className="hidden h-[63px] w-28 sm:block" />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-[14px] font-medium text-ink">{job.title}</p>
              <p className="mt-0.5 truncate text-[12px] text-ink-2">
                {joinMeta([job.site, job.uploader, formatDuration(job.duration)])}
              </p>
              <JobStatusLine job={job} local={props.local[job.id]} />
            </div>
            <JobActions job={job} {...props} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function JobStatusLine({ job, local }: { job: JobView; local?: LocalSave }): React.ReactElement {
  switch (job.status) {
    case "queued":
      return <p className="mt-2 text-[12px] text-ink-3">順番待ち</p>;
    case "running":
    case "finishing":
      return job.status === "finishing" ? (
        <Progress label="MP4 に仕上げています" />
      ) : (
        <Progress
          percent={job.percent}
          label={joinMeta([
            "取得中",
            job.percent !== undefined ? `${Math.floor(job.percent)}%` : undefined,
            job.speed ? `${formatBytes(job.speed)}/秒` : undefined,
            formatEta(job.eta),
          ])}
        />
      );
    case "done":
      return <DoneLine job={job} local={local} />;
    case "canceled":
      return <p className="mt-2 text-[12px] text-ink-3">取り消しました</p>;
    case "error":
      return (
        <div className="mt-2 text-[12px]">
          <p className="flex items-start gap-1.5 text-danger">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span>{job.error?.hint ?? job.error?.message ?? "保存できませんでした"}</span>
          </p>
          {job.error?.hint && <p className="mt-0.5 pl-5 break-all text-ink-3">{job.error.message}</p>}
        </div>
      );
  }
}

function Progress({ percent, label }: { percent?: number; label: string }): React.ReactElement {
  return (
    <div className="mt-2">
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full bg-ink transition-[width] duration-500 ${percent === undefined ? "animate-pulse" : ""}`}
          style={{ width: `${percent ?? 100}%` }}
        />
      </div>
      <p className="mt-1.5 text-[12px] text-ink-2">{label}</p>
    </div>
  );
}

function DoneLine({ job, local }: { job: JobView; local?: LocalSave }): React.ReactElement {
  if (local?.phase === "writing") {
    const percent = job.fileSize ? Math.min(100, (local.written / job.fileSize) * 100) : undefined;
    return (
      <Progress
        percent={percent}
        label={joinMeta(["保存先に書き込み中", percent !== undefined ? `${Math.floor(percent)}%` : undefined])}
      />
    );
  }
  if (local?.phase === "error") {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-[12px] text-danger">
        <AlertCircle size={14} className="mt-px shrink-0" />
        <span>{local.message}</span>
      </p>
    );
  }
  const saved =
    local?.phase === "saved"
      ? joinMeta(["保存しました", formatBytes(job.fileSize), `${local.folder}/${local.name}`])
      : local?.phase === "handed"
        ? joinMeta(["ブラウザのダウンロードに渡しました", formatBytes(job.fileSize)])
        : job.fileState === "delivered"
          ? joinMeta(["保存しました", formatBytes(job.fileSize), job.fileName])
          : undefined;
  if (saved) {
    return (
      <div className="mt-2 text-[12px] text-ink-2">
        <p className="flex items-center gap-1.5">
          <CheckCircle2 size={14} className="shrink-0 text-ink" />
          <span className="truncate">{saved}</span>
        </p>
        {/* ブラウザがダウンロードを止めたときに取り直せるよう、受け取り期限まではリンクを出す */}
        {local?.phase === "handed" && job.fileState === "ready" && (
          <a href={api.fileUrl(job.id)} download className="mt-1 inline-block pl-5 text-ink underline underline-offset-2">
            もう一度ダウンロードする
          </a>
        )}
      </div>
    );
  }
  if (job.fileState === "expired") {
    return <p className="mt-2 text-[12px] text-ink-3">一時ファイルの保管期限が切れました。もう一度保存できます</p>;
  }
  return <Progress label="保存先への書き込みを待っています" />;
}

function JobActions({ job, ...p }: { job: JobView } & JobListProps): React.ReactElement {
  if (job.status === "queued" || job.status === "running" || job.status === "finishing") {
    return <IconButton label="取り消す" onClick={() => p.onCancel(job.id)} icon={<X size={16} />} />;
  }
  return (
    <div className="flex shrink-0 flex-col items-center sm:flex-row">
      {job.status === "done" && p.local[job.id]?.phase === "error" && job.fileState === "ready" && (
        <IconButton label="保存し直す" onClick={() => p.onRetrySave(job.id)} icon={<RotateCw size={16} />} />
      )}
      {(job.status === "error" || job.status === "canceled" || (job.status === "done" && job.fileState === "expired")) && (
        <IconButton label="もう一度保存する" onClick={() => p.onRetry(job)} icon={<RotateCw size={16} />} />
      )}
      <IconButton label="一覧から消す（保存したファイルは残ります）" onClick={() => p.onRemove(job.id)} icon={<X size={16} />} />
    </div>
  );
}
