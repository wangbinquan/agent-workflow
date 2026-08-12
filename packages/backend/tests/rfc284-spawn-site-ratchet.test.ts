// RFC-284 T1（2026-08-12 系统归一审计 N22 / backlog「containedSpawnRegistry 从未
// 存在」）——全仓 spawn 站点棘轮。
//
// RFC-280 把 5 条 agent spawn 链路收敛到 managedProcess 单点后，这个成果只被
// 三个文件级源码锁守着（opencode-spawn-pwd-env.test.ts）；新增一个绕开
// managedProcess 的 spawn 站点不会红任何测试。本棘轮把 src 下**所有** spawn
// 能力触点（Bun.spawn / Bun.spawnSync / node:child_process / 裸 spawn 调用 /
// Bun.$）钉进显式 allowlist：
//   - 新站点不进名单（带 why）即红——先问自己能不能走 runAgentProcess /
//     runManagedProcess / spawnVersionProbe（RFC-284 §1.5/§3.5 收编后的公共面）。
//   - 名单里站点消失即红——棘轮只收不涨，过期条目必须删。
//   - 任何文件把 spawn 能力 re-export 出去即红（白名单 wrapper 洗白通道）。
//
// 扫描口径：逐行匹配，跳过整行注释（trim 后以 // 、* 、/* 开头——当前全部
// 注释命中都是整行注释；行尾内联注释里的提法会被计入，属可接受的保守方向）。
// 变异实证（写入时验证过）：在任意 src 文件加一行 `Bun.spawn(['ls'])` 本测试红；
// 从名单删一行而站点仍在亦红。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_ROOT = join(import.meta.dir, '../src')

const SPAWN_PATTERNS: readonly RegExp[] = [
  /Bun\s*(\.|\[)\s*['"]?spawn/, // Bun.spawn / Bun.spawnSync / Bun['spawn'] 别名与下标形态
  /\bspawnSync\b/, // node:child_process 的 spawnSync 具名使用
  /\bspawn\s*\(/, // 裸 spawn(…) 调用（含别名绑定后的使用）
  /['"]node:child_process['"]/, // 引入该模块本身就是能力触点
  /Bun\s*\.\s*\$/, // Bun.$ 模板串起进程（当前零使用，防将来绕行）
]

/**
 * 显式 allowlist：文件 → { count: 精确命中数, why: 为什么允许 }。
 * 收编类条目标了 removeWhen——对应 RFC-284 批次落地时必须同步更新本表。
 */
const ALLOWLIST: Record<string, { count: number; why: string }> = {
  'services/execution/managedProcess.ts': {
    count: 1,
    why: 'THE agent spawn point（RFC-280）；全部 agent 类进程唯一入口。',
  },
  'util/git.ts': {
    count: 1,
    why: 'git spawn 双点之一（RFC-208 组杀/超时特化语义，豁免有据；与 gitRepoCache 镜像互锁）。',
  },
  'services/gitRepoCache.ts': {
    count: 1,
    why: 'git spawn 双点之二（镜像 util/git.ts，注释互指防漂移；RFC-284 T18 加文本锁）。',
  },
  'util/archive.ts': {
    count: 2,
    why: 'tar czf/xzf 单模块收敛点（文件头自述存在目的就是防散落的手搓 tar spawn）。',
  },
  'util/process.ts': {
    count: 4,
    why: '平台杀链自身的 ps/探测 spawnSync ×3 + RFC-284 T8 的 spawnVersionProbe 骨架（三胞胎探针唯一 spawn 点）。',
  },
  'util/win32Acl.ts': {
    count: 3,
    why: 'win32 icacls DACL 平台工具（node:child_process import + 同步调用）。',
  },
  'cli/doctor.ts': {
    count: 2,
    why: 'doctor 诊断探针（daemon 外一次性 CLI，独立于执行层）。',
  },
  'services/controlListener.ts': {
    count: 1,
    why: 'hardKill 的同步 kill/taskkill 兜底（杀进程原语，同 util/process 豁免理由）。',
  },
  'services/pluginInstaller.ts': {
    count: 2,
    why: 'npm 安装 spawn（import + runCommand）。removeWhen: RFC-284 T16 收编 runManagedProcess。',
  },
  'services/scriptRun.ts': {
    count: 1,
    why: 'probeInterpreter 解释器探针。removeWhen: RFC-284 T17 收编 spawnVersionProbe。',
  },
  'services/structuralDiff/deep/indexers.ts': {
    count: 1,
    why: 'SCIP probeIndexer。removeWhen: RFC-284 T17 补 deadline 并收编探针公共面。',
  },
  'services/structuralDiff/deep/runner.ts': {
    count: 2,
    why: 'SCIP runIndexer 的 SpawnFn 注入缝（别名绑定 + 调用）。RFC-284 T17 换 killProcessTree 时复核。',
  },
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkTsFiles(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

function countSpawnHits(filePath: string): number {
  let hits = 0
  for (const rawLine of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (SPAWN_PATTERNS.some((re) => re.test(rawLine))) hits += 1
  }
  return hits
}

describe('RFC-284 T1 — spawn site ratchet', () => {
  const actual = new Map<string, number>()
  for (const file of walkTsFiles(SRC_ROOT)) {
    const n = countSpawnHits(file)
    if (n > 0) actual.set(relative(SRC_ROOT, file), n)
  }

  test('every spawn site is allowlisted with its exact count (new site ⇒ extend with why)', () => {
    const unlisted = [...actual.entries()]
      .filter(([f, n]) => ALLOWLIST[f] === undefined || ALLOWLIST[f].count !== n)
      .map(([f, n]) => `${f}: ${n} hit(s), allowlisted ${ALLOWLIST[f]?.count ?? 0}`)
    expect(unlisted).toEqual([])
  })

  test('no stale allowlist entries (site gone ⇒ delete the entry; ratchet only shrinks)', () => {
    const stale = Object.keys(ALLOWLIST).filter((f) => !actual.has(f))
    expect(stale).toEqual([])
  })

  test('no file re-exports spawn capability (allowlist wrapper laundering guard)', () => {
    const offenders: string[] = []
    for (const file of walkTsFiles(SRC_ROOT)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
          continue
        if (!trimmed.startsWith('export')) continue
        if (
          /Bun\s*(\.|\[)\s*['"]?spawn/.test(line) ||
          /\bspawnSync\b/.test(line) ||
          /['"]node:child_process['"]/.test(line)
        ) {
          offenders.push(`${relative(SRC_ROOT, file)}: ${trimmed.slice(0, 100)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
