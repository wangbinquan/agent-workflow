#!/bin/sh
# RFC-359 AC-6 —— 把单引擎 HTTP 用例迁到共用双引擎作用域之前，先跑这个。
#
# 为什么存在：这份清单上的每一条都是 2026-09-12 那一轮**实际踩过**的坑，而且多数不会让用例
# 变红——它们让用例**继续跑、但测的已经不是原来那件事**（配置被绕开、加密列解出乱码、
# 交叉积里两层 harness 互不相干）。靠人记必漏：我自己就漏过「两个 grep 判据不同」那一条。
#
# 用法（在 packages/backend/tests 下）：
#   sh ../../../scripts/rfc359-ac6-preflight.sh <test-file...>
#
# 输出 CLEAN 才可以直接上批量迁移；其余每一项的处置见
# design/RFC-359-database-provider-unification/plan.md §5u–§5ah 与 docs/dev-gotchas.md。
#
# 迁完还要看一眼 eslint：`'scope' is defined but never used` **不是 lint 小事**——它说明那个
# describe 根本没吃 provider 作用域，等于双跑一遍却仍然只测了原来那一个引擎。
for f in "$@"; do
  [ -f "$f" ] || { echo "$f | MISSING"; continue; }
  r=""
  grep -q "describeEachProviderHttpApplication" "$f" && r="$r ALREADY-MIGRATED"
  # 注意：与上一条是**两个不同判据** —— 这条排除的是「已经部分双引擎」的文件
  # 注意这**不是**拦路灯：它只是说「整文件包会交叉积」。绝大多数这类文件里，既有的
  # `describeEachProvider` 是**服务层**用例、`createApp` 只在某一个 HTTP describe 里
  # （agents.test.ts 即是），处置是**只包那一个 describe**，其余原样。少数是前几波留下的
  # 「双引擎新半 + SQLite 旧半」并存，得先判旧半还测不测得到新东西，再决定迁还是删。
  grep -qE "describeEachProvider\(" "$f" && r="$r NESTED-EACHPROVIDER(别整文件包,只包 HTTP 那个 describe)"
  grep -qE "\.run\(\)|\.get\(\)|\.all\(\)" "$f" && r="$r SYNC-TERMINAL"
  # 语料按实撞补：任何吃 `StartTaskDeps` / `LegacySqliteTaskDatabase` 的入口都算——它们的 `db`
  # 是 bun:sqlite 专有类型，中立句柄传不进去（`wakeHumanGateContinuation` 2026-09-12 实撞）。
  # **兜底始终是 tsc**：这份名单只为省一次白迁，漏了由 `bunx tsc --noEmit` 当场报出来。
  grep -qE "composeSqlite|composeTestSqlite|LegacySqlite|StartTaskDeps|createTaskExecutionTestTopology|runTaskWithRealTestTopology|wakeHumanGateContinuation|composeHumanGateContinuationDriver|BunSQLiteDatabase" "$f" && r="$r SQLITE-BOUND-INFRA"
  grep -q '\$client' "$f" && r="$r SELF-CLOSES-DB"
  grep -qE "^\s+describe\(" "$f" && r="$r LOOP-OR-NESTED-DESCRIBE"
  grep -qE "writeFileSync\(.*config|applyConfigPatch\(|loadConfig\(" "$f" && r="$r WRITES-OWN-CONFIG(需 open({config}))"
  grep -q "AGENT_WORKFLOW_HOME" "$f" && r="$r OWN-APPHOME(需用 opened.appHome)"
  grep -q "resetRouteMetaRegistry" "$f" && r="$r ROUTE-META-POISON(已知雷)"
  # 「睡一觉等写入」：在 bun:sqlite 上够（同 tick 落盘），在 PostgreSQL 的真实往返上
  # 本机够、忙分片不够——`rfc247-token-audit` 的 AC-20 因此推红一格，而它在本机 3/3 全绿。
  # 迁之前就得换掉：正向用 helpers/eventually 读到为止，负向补因果屏障。
  # 迁完之后由 `test-suite-policy` 的同名守卫兜住（那条只扫已迁的文件）。
  # **有界轮询不算**（`for (;;) { … if (Date.now() > deadline) break; await sleep }` 是正当
  # 形态）；判据与 `test-suite-policy` 的同名守卫一致：往上找同一条用例里的循环 + deadline。
  sleeps=$(python3 - "$f" <<'PYEOF'
import re, sys

lines = open(sys.argv[1]).read().split(chr(10))
pattern = re.compile(r"new Promise\([^)]*\)\s*=>\s*setTimeout|Bun\.sleep\(")
hits = []
for index, line in enumerate(lines):
    if not pattern.search(line):
        continue
    head = 0
    for back in range(index - 1, -1, -1):
        if re.match(r"\s*(?:test|it)\(", lines[back]):
            head = back
            break
    body = chr(10).join(lines[head : index + 1])
    loop = re.search(r"\b(?:for|while)\s*\(([^)]*)\)", body)
    polling = loop is not None and (
        re.search(r"\b(?:break|return|throw)\b", body) or re.search(r"\w\s*\(", loop.group(1) or "")
    )
    if re.match(r"\s*//\s*sleep-ok:", lines[index - 1] if index else ""):
        continue
    if not polling:
        hits.append(str(index + 1))
print(','.join(hits))
PYEOF
)
  [ -n "$sleeps" ] && r="$r SLEEP-TO-WAIT[L$sleeps](直线式睡眠,逐条判:等写入/负向断言/与写入无关)"
  # 「白做的夹具」：某个 describe 挂了 setup 型 beforeEach，正文却**一样都不用**那个 setup
  # 的产物（`rfc264-unicode-names` 三块全是这样——纯 schema 断言，却各建一个 SQLite 库加播
  # 两个用户）。这类不用迁，删掉那行 beforeEach 就够。
  #
  # 判据必须看**全部**产物，不能只看 `db`：`rfc201-plugin-exact-operation` 的两块不提 `db`，
  # 但一块用 `binding`（由 db 建出来的）、一块用 `pluginsDir`（同一个 setup 建的目录）
  # ——只看 `db` 会把它们误报成白做（本轮实撞，报出来才发现判据太松）。
  idle=$(python3 - "$f" <<'PYEOF'
import re, sys

source = open(sys.argv[1]).read()
Q = chr(39)


def block_at(index):
    start = source.find('{', index)
    if start < 0:
        return None
    depth, i = 0, start
    while i < len(source):
        if source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
        i += 1
    return None


# setup 型函数各自产出了哪些模块级绑定
products = {}
for match in re.finditer(r"(?:const|async function|function)\s+(\w*[Ss]etup\w*)\b", source):
    body = block_at(match.end())
    if body is None:
        continue
    products[match.group(1)] = set(re.findall(r"(?m)^\s*(\w+)\s*=[^=]", body))

names = []
for match in re.finditer("(?m)^describe\\(" + Q + "([^" + Q + "]*)", source):
    body = block_at(match.end())
    if body is None:
        continue
    hook = re.search(r"beforeEach\(\s*(?:\(\)\s*=>\s*)?(\w*[Ss]etup\w*)", body)
    if hook is None:
        continue
    produced = products.get(hook.group(1), set())
    if produced and not any(re.search(r"(?<![\w.])" + re.escape(p) + r"(?![\w])", body) for p in produced):
        names.append(match.group(1))
print(','.join(names))
PYEOF
)
  [ -n "$idle" ] && r="$r IDLE-FIXTURE[$idle](整块不用该 setup 的任何产物,删 beforeEach 即可)"
  # `createApp(h.deps)`：选项是个变量，下面那段扫不到任何键，于是 EXTRA-CREATEAPP-OPTS
  # 会**假阴性**（rfc247-mcp-server 实撞：它的 deps 里有 schedulerDriver /
  # taskExecutionReadModels / collaborationContext，PG 侧一个都没有）。看不见就要报出来。
  grep -qE "createApp\([A-Za-z_$][A-Za-z0-9_.$]*\)" "$f" && r="$r OPAQUE-CREATEAPP-OPTS(选项是变量,需人工看)"
  # 模块级 `let h` + 模块级 beforeEach：包 describe 之后钩子看不到 `scope`，当场 ReferenceError
  # （rfc327-memory-filter-and-facets 实撞）。夹具要先上提进 describe 才谈得上迁。
  grep -qE "^(let|var) [A-Za-z_$]+: *Harness|^let h\b" "$f" && r="$r MODULE-LEVEL-HARNESS(夹具需上提)"
  # 纯函数 describe（整块一行 DB 都不碰）不该被整文件包进双引擎 harness——白开一个 PG 库跑
  # 字符串断言（rfc164-workgroup-room 的 `resolveMentions` 实撞）。这类 describe 保持普通
  # `describe`，只有真的要库的那几块才包。判据是**逐块**扫，不是「文件里有 describe」。
  pure=$(python3 - "$f" <<'PYEOF'
import re, sys

source = open(sys.argv[1]).read()
names = []
# 本仓 describe 名一律单引号。引号字符用 chr(39) 拼，避免在 $( ) 里出现不成对的引号
# ——sh 扫命令替换时是**带引号状态**扫的，heredoc 里的裸引号会让它找不到收尾的 `)`。
Q = chr(39)
for match in re.finditer("(?m)^describe\(" + Q + "([^" + Q + "]*)", source):
    start = source.find('{', match.end())
    if start < 0:
        continue
    depth, i = 0, start
    while i < len(source):
        if source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0:
                break
        i += 1
    body = source[start : i + 1]
    if not re.search(r"\bdb\b|\bapp\b|harness|request\(|createApp", body):
        names.append(match.group(1))
print(','.join(names))
PYEOF
)
  [ -n "$pure" ] && r="$r PURE-DESCRIBE[$pure](别包，保持普通 describe)"
  grep -qE "\.seal\(|secretEnc" "$f" && r="$r ENCRYPTED-FIXTURE(需 scope 的 secretBox)"
  opts=$(python3 - "$f" <<'PY'
import sys,re
s=open(sys.argv[1]).read()
i=s.find('createApp('); keys=set()
while i>=0:
    j=s.find('{',i)
    if j<0: break
    d=0;k=j
    while k<len(s):
        if s[k]=='{': d+=1
        elif s[k]=='}':
            d-=1
            if d==0: break
        k+=1
    body=s[j+1:k]; depth=0
    for line in body.split('\n'):
        if depth==0:
            m=re.match(r'\s*([A-Za-z_$][\w$]*)\s*[:,]', line)
            if m: keys.add(m.group(1))
        depth += line.count('{')+line.count('[')-line.count('}')-line.count(']')
    i=s.find('createApp(',k)
extra = keys - {'token','configPath','opencodeVersion','dbVersion','db','secretBox','daemonInfoPath'}
print(','.join(sorted(extra)))
PY
)
  [ -n "$opts" ] && r="$r EXTRA-CREATEAPP-OPTS[$opts]"
  [ -z "$r" ] && r=" CLEAN"
  echo "$f |$r"
done
