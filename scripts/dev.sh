#!/usr/bin/env bash
# 一键启动导演工作台前后端（Ctrl+C 同时停止）
# 用法：./scripts/dev.sh [项目目录]
#   项目目录缺省为当前目录；示例：
#   ./scripts/dev.sh /media/hr/Data/mmh3-creation/elf-and-goblin/mmh3_prompts/elf_and_goblin
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="${1:-$(pwd)}"

echo "▶ 后端 Director Server + MCP（项目: $PROJECT_DIR）"
(cd "$DIR" && pnpm run dev:server "$PROJECT_DIR") &
SERVER_PID=$!
trap 'echo "停止后端…"; kill $SERVER_PID 2>/dev/null || true' EXIT

echo "▶ 前端 Vite → http://127.0.0.1:5173"
(cd "$DIR" && pnpm run dev:web)
