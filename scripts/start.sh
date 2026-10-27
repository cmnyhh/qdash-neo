#!/usr/bin/env bash
# 启动带探针的 DSH web，并把带 token 的地址直接打出来。
#
# 用法：
#   bash scripts/start.sh                                          # 默认 3081 + 探针 patch
#   PORT=4000 bash scripts/start.sh
#   PATCH=../test/patches/group.patch.yml bash scripts/start.sh    # 群场景集成测试
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3081}"
LOG="${QDN_RUN_LOG:-$ROOT/dsh-run/run.log}"
PATCH="${PATCH:-$ROOT/dsh-run/probe.patch.yml}"

cd "$ROOT/dsh-run" || exit 1

if [ ! -d node_modules/@deepseek-ai/dsh ]; then
  echo "缺少依赖。先跑：bash scripts/setup.sh" >&2
  exit 1
fi

echo "==> 启动中（patch=$PATCH 日志 $LOG）"
: > "$LOG"
node node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --patch "$PATCH" --port "$PORT" --no-open > "$LOG" 2>&1 &

PID=$!
echo "==> pid=$PID"

# 等地址出现（最多 90s，首次启动要建索引，慢）
for i in $(seq 1 90); do
  URL=$(grep -o "http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*" "$LOG" 2>/dev/null | tail -1)
  if [ -n "$URL" ]; then
    echo "==> 控制台：$URL"
    echo "==> 探针日志：$LOG"
    echo "        （QDN_PROBE_LOG 可改输出位置）"
    exit 0
  fi
  sleep 1
done

echo "==> 90s 内没拿到 token，看日志：$LOG" >&2
tail -20 "$LOG" >&2
exit 1
