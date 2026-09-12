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
# design/RFC-359-database-provider-unification/plan.md §5u–§5af 与 docs/dev-gotchas.md。
for f in "$@"; do
  [ -f "$f" ] || { echo "$f | MISSING"; continue; }
  r=""
  grep -q "describeEachProviderHttpApplication" "$f" && r="$r ALREADY-MIGRATED"
  # 注意：与上一条是**两个不同判据** —— 这条排除的是「已经部分双引擎」的文件
  grep -qE "describeEachProvider\(" "$f" && r="$r NESTED-EACHPROVIDER(交叉积)"
  grep -qE "\.run\(\)|\.get\(\)|\.all\(\)" "$f" && r="$r SYNC-TERMINAL"
  grep -qE "composeSqlite|composeTestSqlite|LegacySqlite|StartTaskDeps|createTaskExecutionTestTopology|runTaskWithRealTestTopology" "$f" && r="$r SQLITE-BOUND-INFRA"
  grep -q '\$client' "$f" && r="$r SELF-CLOSES-DB"
  grep -qE "^\s+describe\(" "$f" && r="$r LOOP-OR-NESTED-DESCRIBE"
  grep -qE "writeFileSync\(.*config|applyConfigPatch\(|loadConfig\(" "$f" && r="$r WRITES-OWN-CONFIG(需 open({config}))"
  grep -q "AGENT_WORKFLOW_HOME" "$f" && r="$r OWN-APPHOME(需用 opened.appHome)"
  grep -q "resetRouteMetaRegistry" "$f" && r="$r ROUTE-META-POISON(已知雷)"
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
