import { authorize } from "@/lib/server/auth";
import { cancelJob, removeJob } from "@/lib/server/jobs";

// ?action=cancel で止める。指定なしは一覧から外す（保存先に書いたファイルは消さない）。
export async function DELETE(request: Request, ctx: RouteContext<"/api/jobs/[id]">): Promise<Response> {
  const auth = await authorize(request, { mutating: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const action = new URL(request.url).searchParams.get("action");
  if (action === "cancel") cancelJob(auth.user, id);
  else removeJob(auth.user, id);
  return Response.json({ ok: true });
}
