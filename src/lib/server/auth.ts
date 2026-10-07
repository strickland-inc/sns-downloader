import { createRemoteJWKSet, jwtVerify } from "jose";

// 利用者の判定。
// - 社員は Cloudflare Tunnel 経由で PUBLIC_HOST から来る。Cloudflare Access が付ける
//   JWT（Cf-Access-Jwt-Assertion）を検証し、会社のドメインのメールアドレスだけ通す。
// - この Mac から localhost で開いたときは、管理者の "local" として通す。
// - それ以外の Host（DNS rebinding など）は断る。
// AUD などが未設定なら公開側は全部断る（設定漏れで誰でも使える状態にしない）。

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "";
const TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN ?? "";
const AUDIENCE = process.env.CF_ACCESS_AUD ?? "";
const EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN ?? "").toLowerCase();

const jwks = TEAM_DOMAIN
  ? createRemoteJWKSet(new URL(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`))
  : null;

export type Auth = { ok: true; user: string } | { ok: false; response: Response };

function deny(status: number, message: string): Auth {
  return { ok: false, response: Response.json({ error: { message } }, { status }) };
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

// 他サイトのページから送られた、状態を変えるリクエストを断る
function crossSite(request: Request, host: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function authorize(request: Request, options: { mutating: boolean }): Promise<Auth> {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (options.mutating && crossSite(request, host)) {
    return deny(403, "別のサイトからのリクエストは受け付けません");
  }

  // Cloudflare を通ったリクエストには cf-ray が付く。付いていれば必ず JWT を見る
  const viaCloudflare = request.headers.has("cf-ray");
  if (LOCAL_HOST.test(host) && !viaCloudflare) return { ok: true, user: "local" };

  if (!PUBLIC_HOST || host !== PUBLIC_HOST || !jwks || !AUDIENCE || !EMAIL_DOMAIN) {
    return deny(403, "このアドレスからは使えません");
  }
  const token =
    request.headers.get("cf-access-jwt-assertion") ??
    readCookie(request.headers.get("cookie"), "CF_Authorization");
  if (!token) return deny(401, "ログインが切れました。ページを再読み込みしてください");

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${TEAM_DOMAIN}`,
      algorithms: ["RS256"],
      audience: AUDIENCE,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email.endsWith(`@${EMAIL_DOMAIN}`)) {
      return deny(403, `@${EMAIL_DOMAIN} のアカウントだけが使えます`);
    }
    return { ok: true, user: email };
  } catch {
    return deny(401, "ログインが切れました。ページを再読み込みしてください");
  }
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
