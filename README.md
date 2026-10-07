# SNS-Downloader

YouTube・Instagram・TikTok・X などの動画の URL を貼り付けると、プレビューを確認してから MP4 で保存できる社内ツール。

- 社員が開く場所: https://sns-downloader.strickland-ai.com（@strickland-ai.com のメールに届くワンタイム PIN でログイン。30 日有効）
- 管理者がこの Mac で開く場所: http://localhost:3939
- 複数の URL を改行で貼れる。チャンネルや再生リストの URL は一覧から選んで保存する
- 保存先は画面でフォルダを選ぶ（Chrome と Edge）。Safari などはブラウザの既定のダウンロードフォルダに入る

## 仕組み

```
社員のブラウザ ─ Cloudflare Access（PIN）─ Cloudflare Tunnel ─ この Mac の next start（127.0.0.1:3939）─ yt-dlp / ffmpeg
```

1. yt-dlp がこの Mac の `~/Library/Caches/SNS-Downloader/files/<ジョブ ID>/` に MP4 を作る
2. ブラウザがそれを受け取り、選んだフォルダへ書く。書き終えたらこの Mac のファイルは消す
3. 受け取られなかったファイルは 6 時間で消す。yt-dlp は毎日 `brew upgrade` する

この Mac がスリープしている間や電源が切れている間は、社員は使えない。

## 起動と停止

launchd が本体（`com.strickland.sns-downloader`）とトンネル（`com.strickland.sns-downloader-tunnel`）を動かす。

```bash
bash scripts/launchd.sh install    # 初回。ビルドして両方を登録する
bash scripts/launchd.sh restart    # コードを変えたあと（本体だけ再起動）
bash scripts/launchd.sh uninstall  # 両方を外す（社内から使えなくなる）
```

| もの | 場所 |
|---|---|
| 本体のログ | `~/Library/Logs/sns-downloader.log` |
| トンネルのログ | `~/Library/Logs/sns-downloader-tunnel.log` |
| トンネルの設定 | `~/.cloudflared/sns-downloader.yml`（認証情報は同じフォルダの `<トンネル ID>.json`） |
| 保存の履歴 | `~/Library/Application Support/SNS-Downloader/history.json` |

## Cloudflare 側

アカウントは support@strickland-ai.com（strickland-ai.com のゾーンがあるもの）。

| もの | 名前・ID |
|---|---|
| Access アプリ | SNS-Downloader（`e19399f8-db41-4229-b5f8-9b53dd4afdc8`）。ポリシーは `@strickland-ai.com` のメールだけ許可 |
| ログイン方法 | ワンタイム PIN（`29255779-dcc8-45fb-ba4f-79bce9e86db0`）だけ |
| トンネル | sns-downloader（`ab68a1bd-6548-4955-8b87-c69cad8ec5ee`） |
| DNS | `sns-downloader` の CNAME をトンネルへ（プロキシ有効） |
