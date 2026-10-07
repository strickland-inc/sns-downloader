import { authorize, isHttpUrl, readJson } from "@/lib/server/auth";
import { isPublicUrl } from "@/lib/server/target";
import { probe } from "@/lib/server/ytdlp";

// 1回の解析は最長 90 秒の yt-dlp になる。社員全体での同時実行数を抑える
const MAX_PROBING = 4;
let probing = 0;

export async function POST(request: Request): Promise<Response> {
  const auth = await authorize(request, { mutating: true });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const url = typeof body === "object" && body !== null && "url" in body ? body.url : undefined;
  if (!isHttpUrl(url)) {
    return Response.json(
      { error: { message: "URL の形式ではありません", hint: "https:// から始まる URL を貼ってください。" } },
      { status: 400 },
    );
  }

  if (!(await isPublicUrl(url))) {
    return Response.json(
      { error: { message: "この URL は使えません", hint: "公開されている SNS や動画サイトの URL を貼ってください。" } },
      { status: 400 },
    );
  }
  if (probing >= MAX_PROBING) {
    return Response.json(
      { error: { message: "混み合っています", hint: "数秒おいてから、もう一度読み込んでください。" } },
      { status: 429 },
    );
  }
  probing++;
  let outcome: Awaited<ReturnType<typeof probe>>;
  try {
    outcome = await probe(url);
  } finally {
    probing--;
  }
  if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 422 });
  return Response.json({ result: outcome.result });
}
