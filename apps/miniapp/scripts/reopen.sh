#!/bin/sh
# Reopen the project in WeChat devtools with automation on (a full recompile; hot reload misses some
# changes). IDE port from 设置 → 安全设置 → 服务端口; automation on 9420.
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${ZDD_IDE_PORT:-63716}"
run() { "$@" & pid=$!; sleep "$WAIT"; kill $pid 2>/dev/null; }
WAIT=10 run "$CLI" close --project "$ROOT" --port "$PORT" >/dev/null 2>&1
WAIT=35 run "$CLI" auto --project "$ROOT" --auto-port 9420 --port "$PORT" 2>&1 | tail -1
