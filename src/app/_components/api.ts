import type { AppError, JobView, NewJobInput, ProbeResult } from "@/lib/types";

type Outcome<T> = { ok: true; data: T } | { ok: false; error: AppError };

async function call<T>(path: string, init?: RequestInit): Promise<Outcome<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      cache: "no-store",
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error =
        typeof body === "object" && body !== null && "error" in body
          ? (body.error as AppError)
          : { message: `サーバーがエラーを返しました（${res.status}）` };
      return { ok: false, error };
    }
    return { ok: true, data: body as T };
  } catch {
    return {
      ok: false,
      error: { message: "サーバーにつながりません", hint: "SNS-Downloader のサーバーが止まっているか、ネットワークが切れています。" },
    };
  }
}

export const api = {
  probe: (url: string) =>
    call<{ result: ProbeResult }>("/api/probe", { method: "POST", body: JSON.stringify({ url }) }),
  jobs: () => call<{ jobs: JobView[] }>("/api/jobs"),
  createJobs: (items: NewJobInput[]) =>
    call<{ jobs: JobView[] }>("/api/jobs", { method: "POST", body: JSON.stringify({ items }) }),
  cancel: (id: string) => call<unknown>(`/api/jobs/${id}?action=cancel`, { method: "DELETE" }),
  remove: (id: string) => call<unknown>(`/api/jobs/${id}`, { method: "DELETE" }),
  clearFinished: () => call<unknown>("/api/jobs", { method: "DELETE" }),
  fileUrl: (id: string) => `/api/jobs/${id}/file`,
  // 保存先へ書き終えたら、サーバー側の一時ファイルを消してもらう
  delivered: (id: string) => call<unknown>(`/api/jobs/${id}/file`, { method: "DELETE" }),
  // 通常のダウンロードに渡しただけのとき。サーバーは消す時刻を早める
  handed: (id: string) => call<unknown>(`/api/jobs/${id}/file?handed=1`, { method: "DELETE" }),
};
