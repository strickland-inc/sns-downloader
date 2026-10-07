#!/bin/bash
# SNS-Downloader の本体（next start）と Cloudflare Tunnel を launchd に登録する。
# どちらもログイン時に起動し、落ちたら launchd が立ち上げ直す。
#   bash scripts/launchd.sh install    ビルドして両方を登録・起動する
#   bash scripts/launchd.sh restart    コードを変えたあと、ビルドし直して本体だけ再起動する
#   bash scripts/launchd.sh uninstall  両方を外して止める（社内から使えなくなる）
set -euo pipefail

APP_LABEL="com.strickland.sns-downloader"
TUNNEL_LABEL="com.strickland.sns-downloader-tunnel"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
PORT=3939
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_CONFIG="$HOME/.cloudflared/sns-downloader.yml"
CLOUDFLARED="/opt/homebrew/bin/cloudflared"
DOMAIN="gui/$(id -u)"

# launchd は PATH を引き継がないので、node を絶対パスで書き込む
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node が見つかりません" >&2
  exit 1
fi

build() {
  # 文字起こしに使う SpeechTranscriber の小さな実行ファイル。macOS 26 と Xcode の swiftc が要る
  mkdir -p "$APP_DIR/bin"
  swiftc -O "$APP_DIR/scripts/transcribe.swift" -o "$APP_DIR/bin/transcribe"
  (cd "$APP_DIR" && npm install --no-audit --no-fund >/dev/null && npx next build >/dev/null)
}

# $1 ラベル、$2 ログ名、残りが起動コマンド
write_plist() {
  local label="$1" log="$LOGS/$2.log"
  shift 2
  local args=""
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  mkdir -p "$AGENTS" "$LOGS"
  cat >"$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
}

load() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$AGENTS/$1.plist"
}

wait_until_up() {
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
      echo "本体が起動しました: http://localhost:$PORT"
      return 0
    fi
    sleep 1
  done
  echo "30秒待っても本体が応答しません。ログ: $LOGS/sns-downloader.log" >&2
  tail -20 "$LOGS/sns-downloader.log" >&2 || true
  return 1
}

case "${1:-}" in
  install)
    [[ -f "$TUNNEL_CONFIG" ]] || { echo "$TUNNEL_CONFIG がありません" >&2; exit 1; }
    build
    write_plist "$APP_LABEL" sns-downloader \
      "$NODE" "$APP_DIR/node_modules/next/dist/bin/next" start -H 127.0.0.1 -p "$PORT"
    write_plist "$TUNNEL_LABEL" sns-downloader-tunnel \
      "$CLOUDFLARED" --no-autoupdate --config "$TUNNEL_CONFIG" tunnel run
    load "$APP_LABEL"
    wait_until_up
    load "$TUNNEL_LABEL"
    echo "トンネルを起動しました: https://sns-downloader.strickland-ai.com"
    ;;
  restart)
    build
    launchctl kickstart -k "$DOMAIN/$APP_LABEL"
    # 本体が SIGKILL で止まると exit の後始末が走らず、別グループの子が残る。
    # 再起動直後は新しいジョブが無いので、残っているものはすべて前の本体の子
    pkill -f "$APP_DIR/bin/transcribe" 2>/dev/null || true
    pkill -f "Caches/SNS-Downloader/files" 2>/dev/null || true
    pkill -f "sns-downloader/.*_tr/audio.wav" 2>/dev/null || true
    wait_until_up
    ;;
  uninstall)
    for label in "$TUNNEL_LABEL" "$APP_LABEL"; do
      launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
      rm -f "$AGENTS/$label.plist"
    done
    echo "外しました"
    ;;
  *)
    echo "使い方: bash scripts/launchd.sh install|restart|uninstall" >&2
    exit 2
    ;;
esac
