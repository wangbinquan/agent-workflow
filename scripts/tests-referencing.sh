#!/bin/bash
# usage: scripts/tests-referencing.sh <path-or-symbol> [...]
#
# 列出「按文本引用了这些路径 / 符号」的后端测试文件。改文件名 / 删文件的刀，本地批次要按这个清单选，
# 而不是按 RFC 号——逐文件对账的账本（写点白名单、能力债清单、架构锁）散落在与本次 RFC 无关的测试里，
# 按 RFC 号选批次必然漏（2026-09-05 连撞两次：D18 漏 rfc284/rfc349，D19a 漏 s14/rfc217/lifecycle-grep）。
set -e
cd "$(dirname "$0")/.."
[ $# -gt 0 ] || { echo "usage: $0 <path-or-symbol> [...]" >&2; exit 2; }
for needle in "$@"; do
  grep -rl --include='*.ts' -- "$needle" packages/backend/tests 2>/dev/null || true
done | sort -u
