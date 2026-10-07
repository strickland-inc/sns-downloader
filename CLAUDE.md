@AGENTS.md

# SNS-Downloader

社員向けの動画保存ツール。この Mac で動かし、Cloudflare Tunnel と Access で社内に公開している。構成と運用は README.md。

## 守ること

| 対象 | 規則 | 理由 |
|---|---|---|
| 置き場 | Vercel やクラウドの VPS へ移さない | Vercel は yt-dlp と ffmpeg を動かせない。YouTube と Instagram はデータセンターの IP を弾くので、自宅回線のこの Mac で動かしている |
| 認証 | API の route は最初に `authorize()` を通す。公開側は Access の JWT を検証し、`ALLOWED_EMAIL_DOMAIN` のメールだけ通す | Access を外したり設定を誤ったりしても、アプリ側で全部断る形にしている |
| 利用者の分離 | ジョブは `owner`（メールアドレス、localhost は `local`）で分ける。他人のジョブ・ファイルを返さない | 社員同士で保存した動画が見えないようにする |
| `.env.production` | 秘密の値を入れない（AUD・チームドメインなど公開情報だけ。git で追跡している） | トンネルの認証情報は `~/.cloudflared/` に置く |
| yt-dlp の引数 | `-S vcodec:h264,res,acodec:m4a`、`--no-mtime`、URL の前の `--` を外さない | QuickTime と iPhone で再生できる形にする。更新日時で消す保存先で古い投稿が消えないようにする。URL をオプションとして読ませない |
| 反映 | コードを変えたら `bash scripts/launchd.sh restart` | launchd が動かしているのは `next build` の成果物。`bin/transcribe` もこのとき swiftc でビルドし直す |
| 文字起こし | 日本語（ja-JP）の SpeechTranscriber だけを使う。英語などの資産をこの Mac に落とすときは利用者に確認する | 利用者が日本語だけと決めた（2026-10-07）。英語の動画は崩れた文になる |
| 検索エンジン | noindex は metadata・robots.ts・`X-Robots-Tag` の3か所 | 利用者の指示（2026-10-07） |

## Cloudflare の API トークン

vault の `STRICKLAND_CF_API_TOKEN` で Access アプリ・トンネル・DNS を操作できる。ログイン方法（IdP）の追加・一覧はこのトークンでは `auth.forbidden` になるので、ダッシュボード（Chrome の strickland プロファイル）で行う。

## 未実装

- Google ログイン（いまはワンタイム PIN。Google を足すには GCP で OAuth クライアントを作る必要がある）
- ログインが要る投稿の保存（利用者が不要と決めた。2026-10-07）
