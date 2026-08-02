#!/bin/bash
# RFC-248 PR-3 流水线原型：验证 materializeGroupSpace 的完整语义。
# 布局（模拟一个真实仓库组）：
#   ''              → app        (可写, 挂根)
#   vendor/sdk      → sdk        (只读, 嵌在 app 工作树里)
#   vendor/sdk/ext  → ext        (可写, 三层嵌套：嵌在 sdk 里)
#   site/docs       → docs@guides(可写, sparse 子目录挂载, 嵌在 app 里)
#   compare/main    → app@main   (可写, 同一个仓第二次出现 → 分支带序号)
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)/run"
rm -rf "$S"; mkdir -p "$S"; cd "$S"
ID="T01HZZ"
GIT="git -c user.name=aw -c user.email=aw@x -c commit.gpgsign=false"

mkrepo() { # name, files...
  local n=$1; shift
  $GIT init -q "$S/src/$n"
  for f in "$@"; do mkdir -p "$S/src/$n/$(dirname "$f")"; echo "orig-$n-$f" > "$S/src/$n/$f"; done
  $GIT -C "$S/src/$n" add -A; $GIT -C "$S/src/$n" commit -qm init
}
mkdir -p "$S/src"
mkrepo app   src/main.ts package.json
mkrepo sdk   lib/sdk.ts README.md
mkrepo ext   ext/plug.ts
mkrepo docs  guides/g1.md guides/g2.md api/a.md README.md

ROOT="$S/wt/$ID"

# ---- 层 0：挂根的 app ------------------------------------------------------
mkdir -p "$(dirname "$ROOT")"
$GIT -C "$S/src/app" worktree add -q "$ROOT" -b "agent-workflow/$ID"
echo "== L0 app 挂根 =="; ls -A "$ROOT" | grep -v '^\.git$' | tr '\n' ' '; echo

# ---- 层 0 的预置 commit：排除它的【直接】子挂载点 --------------------------
# directChildren('') = vendor/sdk, site/docs, compare/main   (vendor/sdk/ext 归 vendor/sdk)
{ echo; echo "# >>> agent-workflow: nested repo mounts (task $ID) >>>"
  echo "/vendor/sdk/"; echo "/site/docs/"; echo "/compare/main/"; echo "/.agent-workflow-inputs/"
  echo "# <<< agent-workflow: nested repo mounts <<<"; } >> "$ROOT/.gitignore"
$GIT -C "$ROOT" add .gitignore
$GIT -C "$ROOT" commit -qm "chore(agent-workflow): exclude nested repo mounts"
BASE_APP=$($GIT -C "$ROOT" rev-parse HEAD)
echo "== app base_commit = ${BASE_APP:0:8} =="

# ---- 层 1 --------------------------------------------------------------------
$GIT -C "$S/src/sdk" worktree add -q "$ROOT/vendor/sdk" -b "agent-workflow/$ID"
# sdk 自己也有直接子（vendor/sdk/ext）→ 一视同仁造预置 commit（D21，只读也造）
{ echo; echo "# >>> agent-workflow: nested repo mounts (task $ID) >>>"
  echo "/ext/"; echo "# <<< agent-workflow: nested repo mounts <<<"; } >> "$ROOT/vendor/sdk/.gitignore"
$GIT -C "$ROOT/vendor/sdk" add .gitignore
$GIT -C "$ROOT/vendor/sdk" commit -qm "chore(agent-workflow): exclude nested repo mounts"
BASE_SDK=$($GIT -C "$ROOT/vendor/sdk" rev-parse HEAD)

# sparse 成员：docs 仓只检出 guides/
$GIT -C "$S/src/docs" worktree add -q --no-checkout "$ROOT/site/docs" -b "agent-workflow/$ID"
$GIT -C "$ROOT/site/docs" sparse-checkout set --no-cone '/guides/'
$GIT -C "$ROOT/site/docs" checkout -q
BASE_DOCS=$($GIT -C "$ROOT/site/docs" rev-parse HEAD)

# 同一个 app 仓第二次出现 → 分支必须带序号
$GIT -C "$S/src/app" worktree add -q "$ROOT/compare/main" -b "agent-workflow/$ID-2"
BASE_CMP=$($GIT -C "$ROOT/compare/main" rev-parse HEAD)

# ---- 层 2 --------------------------------------------------------------------
$GIT -C "$S/src/ext" worktree add -q "$ROOT/vendor/sdk/ext" -b "agent-workflow/$ID"
BASE_EXT=$($GIT -C "$ROOT/vendor/sdk/ext" rev-parse HEAD)

echo
echo "===== 物化后：每个仓的 status（全部应为空）====="
for p in "" vendor/sdk vendor/sdk/ext site/docs compare/main; do
  d="$ROOT${p:+/$p}"
  out=$($GIT -C "$d" status --porcelain)
  printf '  %-16s %s\n' "${p:-<root>}" "${out:-（干净）}"
done

echo
echo "===== sparse 成员挂点内容（应只有 guides）====="
ls -A "$ROOT/site/docs" | grep -v '^\.git$' | tr '\n' ' '; echo

echo
echo "===== 模拟 worker 干活 ====="
echo "worker" >> "$ROOT/src/main.ts"                       # app 改
echo "worker" >> "$ROOT/site/docs/guides/g1.md"            # docs 改
echo "worker" >> "$ROOT/vendor/sdk/ext/ext/plug.ts"        # ext 改
echo "oops"   >> "$ROOT/vendor/sdk/lib/sdk.ts"             # 只读仓被误改
echo "new"     > "$ROOT/newfile.md"                        # app 新增未跟踪
mkdir -p "$ROOT/.agent-workflow-inputs"; echo up > "$ROOT/.agent-workflow-inputs/u.txt"

echo
echo "===== 各仓 diff（相对各自 base_commit，含未跟踪）====="
diffof() { # dir base label
  local d=$1 b=$2 l=$3
  local tracked untracked
  tracked=$($GIT -C "$d" diff "$b" --name-only)
  untracked=$($GIT -C "$d" ls-files --others --exclude-standard)
  printf '  %-16s tracked=[%s] untracked=[%s]\n' "$l" "$(echo $tracked)" "$(echo $untracked)"
}
diffof "$ROOT"                "$BASE_APP"  "<root> app"
diffof "$ROOT/vendor/sdk"     "$BASE_SDK"  "vendor/sdk(ro)"
diffof "$ROOT/vendor/sdk/ext" "$BASE_EXT"  "vendor/sdk/ext"
diffof "$ROOT/site/docs"      "$BASE_DOCS" "site/docs"
diffof "$ROOT/compare/main"   "$BASE_CMP"  "compare/main"

echo
echo "===== 模拟 RFC-075 自动提交推送：对可写仓跑 add -A（只读仓跳过）====="
for p in "" vendor/sdk/ext site/docs compare/main; do
  d="$ROOT${p:+/$p}"
  out=$($GIT -C "$d" add -A 2>&1 || true)
  staged=$($GIT -C "$d" diff --cached --name-only | tr '\n' ' ')
  printf '  %-16s staged=[%s] %s\n' "${p:-<root>}" "$staged" "${out:+⚠ $out}"
done

echo
echo "===== 幂等复检：对 app 再跑一次预置 commit 的规则计算 ====="
if grep -qF '/vendor/sdk/' "$ROOT/.gitignore"; then echo "  规则已存在 → 跳过 commit（幂等 ✓）"; else echo "  ✗ 幂等失败"; fi

echo
echo "===== 分支名 ====="
for p in "" compare/main; do
  d="$ROOT${p:+/$p}"
  printf '  %-16s %s\n' "${p:-<root>}" "$($GIT -C "$d" rev-parse --abbrev-ref HEAD)"
done
