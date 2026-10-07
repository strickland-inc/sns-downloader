import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { connection } from "next/server";
import { authorize } from "@/lib/server/auth";
import { markDelivered, markHanded, readyFile } from "@/lib/server/jobs";

// 保存した MP4 をブラウザへ渡す
export async function GET(request: Request, ctx: RouteContext<"/api/jobs/[id]/file">): Promise<Response> {
  await connection();
  const auth = await authorize(request, { mutating: false });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const file = readyFile(auth.user, id);
  if (!file) {
    return Response.json(
      { error: { message: "ファイルがありません", hint: "時間がたって削除されました。もう一度保存してください。" } },
      { status: 404 },
    );
  }
  const stream = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
  const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(stream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private, no-store",
    },
  });
}

// ブラウザが保存先へ書き終えたことを知らせる。この Mac からはファイルを消す。
// ?handed=1 は通常のダウンロードに渡しただけのとき。受け取りを確かめられないので、消す時刻を早める。
export async function DELETE(request: Request, ctx: RouteContext<"/api/jobs/[id]/file">): Promise<Response> {
  const auth = await authorize(request, { mutating: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (new URL(request.url).searchParams.get("handed") === "1") markHanded(auth.user, id);
  else markDelivered(auth.user, id);
  return Response.json({ ok: true });
}
