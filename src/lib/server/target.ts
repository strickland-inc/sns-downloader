import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// yt-dlp にこの Mac から社内ネットワークや localhost を取りに行かせない。
// プリンタ（192.168.0.71）やこのサーバー自身の API に届いてしまうため。
// リダイレクト先までは見ていない。公開サイトの URL を前提にした最低限の検査。
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

function isBlocked(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    // ::ffff:192.168.0.1 のような IPv4 射影も IPv4 として見る
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return mapped ? blocked.check(mapped[1], "ipv4") : blocked.check(address, "ipv6");
  }
  return true;
}

const cache = new Map<string, { ok: boolean; at: number }>();
const CACHE_MS = 10 * 60 * 1000;

export async function isPublicUrl(url: string): Promise<boolean> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
  let ok: boolean;
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    ok = addresses.length > 0 && addresses.every((a) => !isBlocked(a.address));
  } catch {
    // 名前解決に失敗した URL は yt-dlp に渡しても落ちるだけなので、ここで止める
    ok = false;
  }
  cache.set(host, { ok, at: Date.now() });
  return ok;
}
