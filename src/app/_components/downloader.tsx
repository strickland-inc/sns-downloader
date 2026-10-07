"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVE_STATUSES, type JobView, type NewJobInput } from "@/lib/types";
import { api } from "./api";
import { Composer } from "./composer";
import { extractUrls } from "./format";
import { JobList } from "./job-list";
import { PreviewList, type PreviewItem } from "./preview-list";
import { SaveTarget } from "./save-target";
import { useLocalSave } from "./use-local-save";

const PROBE_PARALLEL = 3;
const POLL_MS = 1000;
// これより本数が少ない一覧（Instagram のカルーセルなど）は最初から全部選んでおく
const AUTO_SELECT_MAX = 20;

let keySeq = 0;
const nextKey = (): string => `p${++keySeq}`;

export function Downloader(): React.ReactElement {
  const [input, setInput] = useState("");
  const [previews, setPreviews] = useState<PreviewItem[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  // 古い応答が後から届いて新しい一覧を上書きしないよう、通し番号で捨てる
  const jobsSeq = useRef(0);
  const refreshJobs = useCallback(async () => {
    const seq = ++jobsSeq.current;
    const r = await api.jobs();
    if (r.ok && seq === jobsSeq.current) setJobs(r.data.jobs);
  }, []);

  // 初回の読み込み。結果はコールバックで受け取る（effect の中で直接 setState しない）
  useEffect(() => {
    void api.jobs().then((r) => r.ok && setJobs(r.data.jobs));
  }, []);

  const save = useLocalSave(jobs, refreshJobs);

  const hasActive = jobs.some((j) => ACTIVE_STATUSES.includes(j.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void refreshJobs(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, refreshJobs]);

  // ---- プレビュー ----------------------------------------------------------

  const patchPreview = useCallback((key: string, next: PreviewItem | null) => {
    setPreviews((items) =>
      next === null ? items.filter((i) => i.key !== key) : items.map((i) => (i.key === key ? next : i)),
    );
  }, []);

  const probeOne = useCallback(
    async (key: string, url: string) => {
      const r = await api.probe(url);
      if (!r.ok) {
        patchPreview(key, { key, url, state: "error", error: r.error });
        return;
      }
      const result = r.data.result;
      if (result.kind === "video") {
        const { title, uploader, site, thumbnail, duration } = result;
        const meta = { title, uploader, site, thumbnail, duration };
        patchPreview(key, { key, url: result.url, state: "video", meta, selected: true });
      } else {
        const selectable = result.entries.filter((e) => !e.isList);
        const selected = selectable.length <= AUTO_SELECT_MAX ? selectable.map((e) => e.key) : [];
        patchPreview(key, { key, url, state: "list", list: result, selected });
      }
    },
    [patchPreview],
  );

  const addUrls = useCallback(
    (urls: readonly string[]) => {
      const known = new Set(previews.map((p) => p.url));
      const fresh = urls.filter((u) => !known.has(u)).map((url) => ({ key: nextKey(), url }));
      if (fresh.length === 0) return;
      setPreviews((items) => [...items, ...fresh.map((f) => ({ ...f, state: "loading" as const }))]);

      const queue = [...fresh];
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next; next = queue.shift()) await probeOne(next.key, next.url);
      };
      void Promise.all(Array.from({ length: Math.min(PROBE_PARALLEL, queue.length) }, worker));
    },
    [previews, probeOne],
  );

  const handleSubmit = (): void => {
    const urls = extractUrls(input);
    if (urls.length === 0) return;
    addUrls(urls);
    setInput("");
  };

  const retryPreview = (key: string): void => {
    const item = previews.find((p) => p.key === key);
    if (!item) return;
    patchPreview(key, { key, url: item.url, state: "loading" });
    void probeOne(key, item.url);
  };

  const toggleVideo = (key: string): void =>
    setPreviews((items) => items.map((i) => (i.key === key && i.state === "video" ? { ...i, selected: !i.selected } : i)));

  const toggleEntry = (key: string, entryKey: string): void =>
    setPreviews((items) =>
      items.map((i) =>
        i.key === key && i.state === "list"
          ? {
              ...i,
              selected: i.selected.includes(entryKey)
                ? i.selected.filter((k) => k !== entryKey)
                : [...i.selected, entryKey],
            }
          : i,
      ),
    );

  const toggleAll = (key: string, select: boolean): void =>
    setPreviews((items) =>
      items.map((i) =>
        i.key === key && i.state === "list"
          ? { ...i, selected: select ? i.list.entries.filter((e) => !e.isList).map((e) => e.key) : [] }
          : i,
      ),
    );

  const selectedInputs = (): NewJobInput[] =>
    previews.flatMap((item): NewJobInput[] => {
      if (item.state === "video") return item.selected ? [{ url: item.url, ...item.meta }] : [];
      if (item.state !== "list") return [];
      return item.list.entries
        .filter((e) => item.selected.includes(e.key))
        .map((e) => ({
          url: e.url,
          playlistIndex: e.playlistIndex,
          title: e.title,
          uploader: e.uploader ?? item.list.uploader,
          site: e.site,
          thumbnail: e.thumbnail,
          duration: e.duration,
        }));
    });

  const selectedCount = selectedInputs().length;

  const handleSave = async (): Promise<void> => {
    const inputs = selectedInputs();
    if (inputs.length === 0) return;
    // フォルダ選択と書き込みの許可は、クリックの直後でないと出せない
    const ready = await save.prepare();
    if (!ready.ok) {
      showToast(ready.message ?? "保存先のフォルダを選んでください");
      return;
    }
    const sentKeys = new Set(
      previews
        .filter((i) => (i.state === "video" && i.selected) || (i.state === "list" && i.selected.length > 0))
        .map((i) => i.key),
    );
    setSaving(true);
    const r = await api.createJobs(inputs);
    setSaving(false);
    if (!r.ok) {
      showToast(r.error.hint ?? r.error.message);
      return;
    }
    // 保存に回したものはプレビューから外す。読み込み中・失敗・未選択は残す。
    setPreviews((items) => items.filter((i) => !sentKeys.has(i.key)));
    jobsSeq.current++;
    setJobs((current) => [...r.data.jobs, ...current]);
  };

  // ---- ダウンロード --------------------------------------------------------

  const handleRetryJob = async (job: JobView): Promise<void> => {
    const { url, playlistIndex, title, uploader, site, thumbnail, duration } = job;
    const r = await api.createJobs([{ url, playlistIndex, title, uploader, site, thumbnail, duration }]);
    if (!r.ok) {
      showToast(r.error.hint ?? r.error.message);
      return;
    }
    await api.remove(job.id);
    await refreshJobs();
  };

  const empty = previews.length === 0 && jobs.length === 0;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4 sm:px-6">
          <p className="text-[16px] font-semibold tracking-[0.01em] text-ink">SNS-Downloader</p>
        </div>
      </header>

      <main className={`mx-auto w-full max-w-3xl flex-1 px-4 pb-16 sm:px-6 ${empty ? "pt-[18vh]" : "pt-8"}`}>
        {empty && (
          <h1 className="mb-8 text-center text-[26px] font-medium tracking-[0.01em] text-ink sm:text-[28px]">
            保存したい動画の URL を貼り付け
          </h1>
        )}
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          busy={previews.some((p) => p.state === "loading")}
        />
        <SaveTarget save={save} onError={showToast} />

        {previews.length > 0 && (
          <PreviewList
            items={previews}
            onToggleVideo={toggleVideo}
            onToggleEntry={toggleEntry}
            onToggleAll={toggleAll}
            onOpenList={(url) => addUrls([url])}
            onRetry={retryPreview}
            onRemove={(key) => patchPreview(key, null)}
            onClear={() => setPreviews([])}
            onSave={() => void handleSave()}
            selectedCount={selectedCount}
            saving={saving}
          />
        )}

        {jobs.length > 0 && (
          <JobList
            jobs={jobs}
            onCancel={(id) => void api.cancel(id).then(refreshJobs)}
            onRemove={(id) => {
              // まだ保存先へ書いていないファイルは、一覧から消すとサーバーからも消える
              const job = jobs.find((j) => j.id === id);
              if (job?.fileState === "ready" && save.local[id]?.phase !== "saved" &&
                  !window.confirm("まだ保存先に書き込んでいません。一覧から消すと保存できなくなります。消しますか？")) {
                return;
              }
              void api.remove(id).then(refreshJobs);
            }}
            onRetry={(job) => void handleRetryJob(job)}
            onRetrySave={save.retry}
            local={save.local}
            onClearFinished={() => void api.clearFinished().then(refreshJobs)}
          />
        )}
      </main>

      {toast && (
        <div role="status" className="fixed inset-x-0 top-16 z-30 flex justify-center px-4">
          <p className="max-w-lg rounded-2xl bg-ink px-4 py-2.5 text-[13px] text-white shadow-lg">{toast}</p>
        </div>
      )}
    </div>
  );
}
