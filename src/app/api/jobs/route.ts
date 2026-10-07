import { connection } from "next/server";
import { authorize, isHttpUrl, readJson } from "@/lib/server/auth";
import { clearFinished, createJobs, listJobs } from "@/lib/server/jobs";
import { isPublicUrl } from "@/lib/server/target";
import type { NewJobInput } from "@/lib/types";

const MAX_BATCH = 500;

export async function GET(request: Request): Promise<Response> {
  await connection();
  const auth = await authorize(request, { mutating: false });
  if (!auth.ok) return auth.response;
  return Response.json({ jobs: listJobs(auth.user) });
}

function toInput(value: unknown): NewJobInput | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isHttpUrl(v.url)) return null;
  const text = (x: unknown, max: number): string | undefined =>
    typeof x === "string" && x.length > 0 ? x.slice(0, max) : undefined;
  const index =
    typeof v.playlistIndex === "number" && Number.isInteger(v.playlistIndex) && v.playlistIndex > 0
      ? v.playlistIndex
      : undefined;
  return {
    url: v.url,
    playlistIndex: index,
    title: text(v.title, 300) ?? v.url,
    uploader: text(v.uploader, 200),
    site: text(v.site, 50) ?? "Web",
    thumbnail: isHttpUrl(v.thumbnail) ? v.thumbnail : undefined,
    duration: typeof v.duration === "number" && Number.isFinite(v.duration) ? v.duration : undefined,
  };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authorize(request, { mutating: true });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const items = typeof body === "object" && body !== null && "items" in body ? body.items : undefined;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
    return Response.json({ error: { message: "保存する動画が指定されていません" } }, { status: 400 });
  }
  const inputs = items.map(toInput);
  if (inputs.some((i) => i === null)) {
    return Response.json({ error: { message: "URL の形式ではない項目があります" } }, { status: 400 });
  }
  const valid = inputs as NewJobInput[];
  const checked = await Promise.all([...new Set(valid.map((i) => i.url))].map(isPublicUrl));
  if (checked.some((ok) => !ok)) {
    return Response.json({ error: { message: "使えない URL が含まれています" } }, { status: 400 });
  }
  const result = createJobs(auth.user, valid);
  if (!result.ok) return Response.json({ error: { message: result.message } }, { status: 429 });
  return Response.json({ jobs: result.jobs });
}

// 終わったものを一覧から消す。保存先に書いたファイルには触れない。
export async function DELETE(request: Request): Promise<Response> {
  const auth = await authorize(request, { mutating: true });
  if (!auth.ok) return auth.response;
  clearFinished(auth.user);
  return Response.json({ ok: true });
}
