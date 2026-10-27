#!/usr/bin/env bash
# 一次性环境初始化：装依赖 + 把探针放进 DSH profile。
#
# 为什么要 --ignore-scripts：本机没有 C++ 编译器（VS 只装了 Redist），
# koffi 之类的原生包会在 postinstall 里编译失败。DSH 运行不需要它们。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"

echo "==> 项目根目录: $ROOT"
echo "==> DSH profile: $PROFILE_DIR"

echo "==> [1/3] 安装 DSH 运行时（约 600 包，几分钟）"
cd "$ROOT/dsh-run"
npm install --ignore-scripts --omit=optional --no-audit --no-fund

echo "==> [2/3] 安装探针到 profile（插件解析以 profile 目录为基准）"
mkdir -p "$PROFILE_DIR/node_modules/qdn-probe/lib"
cp "$ROOT/probe/package.json" "$PROFILE_DIR/node_modules/qdn-probe/package.json"
cp "$ROOT/probe/lib/index.js" "$PROFILE_DIR/node_modules/qdn-probe/lib/index.js"
cp "$ROOT/probe/lib/client.js" "$PROFILE_DIR/node_modules/qdn-probe/lib/client.js"

echo "==> [3/3] 安装 qdash-neo 插件到 profile"
DEST="$PROFILE_DIR/node_modules/qdash-neo"
mkdir -p "$DEST"
cp "$ROOT/package.json" "$DEST/package.json"
cp "$ROOT/cordis.patch.yml" "$DEST/cordis.patch.yml"
rm -rf "$DEST/src"
cp -R "$ROOT/src" "$DEST/src"

# 假模型只在集成测试里用（本机没有 LLM key），默认不装
if [ "${QDN_WITH_FAKE_MODEL:-0}" = "1" ]; then
  echo "==> 额外安装假模型 qdn-fake-model（集成测试用）"
  mkdir -p "$PROFILE_DIR/node_modules/qdn-fake-model"
  cp "$ROOT/test/fake-model/package.json" "$PROFILE_DIR/node_modules/qdn-fake-model/package.json"
  cp "$ROOT/test/fake-model/index.js" "$PROFILE_DIR/node_modules/qdn-fake-model/index.js"
fi

cat <<'EOF'

完成。启动方式：

  bash scripts/start.sh

或手动（**参数顺序不要改**，这是实测能跑的那一条）：

  cd dsh-run
  node node_modules/@deepseek-ai/dsh/lib/bin.js \
    --profile web --patch ./probe.patch.yml --port 3081 --no-open

token 只打在 stdout 里，需要重定向到文件再 grep `token=`。
EOF
