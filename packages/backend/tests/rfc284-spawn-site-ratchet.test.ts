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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_ROOT = join(import.meta.dir, '../src')

const SPAWN_PATTERNS: readonly RegExp[] = [
  /Bun\s*(\.|\[)\s*['"]?spawn/, // Bun.spawn / Bun.spawnSync / Bun['spawn'] 别名与下标形态
  /\bspawnSync\b/, // node:child_process 的 spawnSync 具名使用
  /\bspawn\s*\(/, // 裸 spawn(…) 调用（含别名绑定后的使用）
  /['"](node:)?child_process['"]/, // 引入该模块本身就是能力触点（含不带 node: 前缀的裸形）
  /Bun\s*\.\s*\$/, // Bun.$ 模板串起进程（当前零使用，防将来绕行）
  // RFC-284 T29 路 2 实证补盲区：exec 族与 fork 同样起进程，原五条正则全放行
  //（execFile('git',…) 样本零命中）。只锁**裸调用形**（负回顾排除 `.exec(` ——
  // sqlite Database.exec / RegExp.exec 是全然无关的方法名）；`cp.exec(...)` 的
  // 命名空间形无需在此覆盖：其 import/require('child_process') 行已被上面的
  // 模块模式命中。当前 src 零在逃站点——纯硬化，非追捕。
  /(?<![.\w'"])(exec|execFile|execFileSync|execSync|fork)\s*\(/,
]

/**
 * 显式 allowlist：文件 → { count: 精确命中数, why: 为什么允许 }。
 * 收编类条目标了 removeWhen——对应 RFC-284 批次落地时必须同步更新本表。
 */
/**
 * RFC-317 T34（EK-01）—— 每个被登记的 spawn 站点必须声明它**怎么被治理**。
 *
 * 改造前 allowlist 只有 `{ count, why }`：站点是可枚举的，但「它有没有自成进程组、
 * 有没有整组杀、输出有没有上限」一条都没有断言。EK-01 就落在这个盲区里——两个
 * RFC-310 runner 起的正是**存在意义就是 fork 子进程**的程序（npm/bun/cargo、外部
 * 适配器可执行文件），却既不 detached 也不树杀；其中一个还先把 stdout 完整读进内存、
 * 之后才去判断 256 KiB 的「上限」。站点被登记了，缺陷照样落地。
 *
 *   · `kernel`        —— 杀链 / 受管进程内核本身。
 *   · `process-group` —— 自成进程组且整组杀。**有 AST 断言**：必须同时出现
 *                        `detached: true` 与一处组杀（`killProcessTree` 或
 *                        `process.kill(-pid)`）。
 *   · `short-lived`   —— 不 fork、输出天然有界，无需组治理；why 必须说清为什么。
 *   · `not-a-spawn`   —— 命中的是同名相位钩子等，本身不起进程。
 */
type SpawnGovernance = 'kernel' | 'process-group' | 'short-lived' | 'not-a-spawn'

const ALLOWLIST: Record<string, { governance: SpawnGovernance; count: number; why: string }> = {
  'services/schedulerAssembly.ts': {
    governance: 'not-a-spawn',
    count: 3,
    why:
      'RFC-287 装配骨架的 `spawn` **相位钩子名**——本身不起进程，但五条装配线的真实' +
      '起进程调用（runNode / runScriptProcess）全部经它转发，是能力触点的收口处，' +
      '故照实登记而非改名绕开棘轮。三处 = 接口方法声明 + 模式 A 的首次调用 + ' +
      'T5b 模式 B 重试循环里的再次调用（跨 attempt 窗口内由 retryPolicy 驱动）。',
  },
  'services/execution/managedProcess.ts': {
    governance: 'kernel',
    count: 1,
    why: 'THE agent spawn point（RFC-280）；全部 agent 类进程唯一入口。',
  },
  'services/execution/managedProcessLauncher.ts': {
    governance: 'kernel',
    count: 1,
    why:
      'RFC-328 预激活 launcher 的唯一 target spawn；launcher 已是 detached 组长，' +
      'target 显式留在同一进程组，使既有 TERM→KILL 树杀覆盖整棵运行时进程树。',
  },
  'util/git.ts': {
    governance: 'process-group',
    count: 1,
    why: 'git spawn 双点之一（RFC-208 组杀/超时特化语义，豁免有据；与 gitRepoCache 镜像互锁）。',
  },
  'services/gitRepoCache.ts': {
    governance: 'process-group',
    count: 1,
    why: 'git spawn 双点之二（镜像 util/git.ts，注释互指防漂移；RFC-284 T18 加文本锁）。',
  },
  'util/archive.ts': {
    governance: 'short-lived',
    count: 2,
    why: 'tar czf/xzf 单模块收敛点（文件头自述存在目的就是防散落的手搓 tar spawn）。',
  },
  'util/process.ts': {
    governance: 'kernel',
    count: 5,
    why: '平台杀链自身的 ps/探测 spawnSync ×3 + RFC-284 T8 的 spawnVersionProbe 骨架（三胞胎探针唯一 spawn 点）+ isProcessAlive 的 `ps -o stat=` 僵尸判定：POSIX `kill(pid,0)` 对等待回收的僵尸同样成功，把僵尸当活会让 TERM→KILL 恢复误判「agent 还活着」并中止 daemon 启动，故必须另读进程状态位。',
  },
  'util/win32Acl.ts': {
    governance: 'short-lived',
    count: 3,
    why: 'win32 icacls DACL 平台工具（node:child_process import + 同步调用）。',
  },
  'cli/doctor.ts': {
    governance: 'short-lived',
    count: 2,
    why: 'doctor 诊断探针（daemon 外一次性 CLI，独立于执行层）。',
  },
  'services/controlListener.ts': {
    governance: 'short-lived',
    count: 1,
    why: 'hardKill 的同步 kill/taskkill 兜底（杀进程原语，同 util/process 豁免理由）。',
  },
  'services/structuralDiff/deep/runner.ts': {
    governance: 'process-group',
    count: 2,
    why: 'SCIP runIndexer 的 SpawnFn 注入缝（别名绑定 + 调用）；T17 已换树杀（stub 无 pid 走原 kill 缝）。',
  },
  'modules/development-automation/infrastructure/gitBaselineReader.ts': {
    governance: 'short-lived',
    count: 1,
    why:
      'RFC-310 PR-3 baseline blob 读取：`git cat-file blob` 的 stdout 必须直连文件（Bun.file）' +
      '流式落盘再 hash——runGit 走 text() 会把二进制字节按 utf8 解码损坏，无法复用；' +
      '只读 git 对象、nonInteractiveGitEnv、用后即删临时目录。',
  },
  'modules/development-automation/infrastructure/verificationRunner.ts': {
    governance: 'process-group',
    count: 1,
    why:
      'RFC-310 PR-5 T57 verification 程序执行点：disposable workspace 内跑受管 build/test，' +
      'stdout/stderr 直连文件（管道会被脚本的长命孙进程钉住不闭合）、timeout TERM→KILL、' +
      '空 env（PATH/HOME/TMPDIR）+ platformSpawnOptionsForHost；receipt 只信 exit code。',
  },
  'modules/development-automation/composition/legacyDevelopmentProgramUpgrade.ts': {
    governance: 'short-lived',
    count: 2,
    why:
      'RFC-323 legacy program 升级只生成一次性 Node 兼容包装器；包装器同步执行一笔已冻结程序，' +
      '以 120 秒 timeout 和 5 MiB maxBuffer 双重封顶，不把 spawn 能力导出给平台调用方。',
  },
  'modules/integration/infrastructure/developmentAdapterRunner.ts': {
    governance: 'process-group',
    count: 1,
    why:
      'RFC-310 adapter runner：外部 adapter 程序的唯一执行点——one-shot staged sink 为 cwd、' +
      '空对象起 env（PATH/HOME/TMPDIR + AW_* 票据 + 声明的 secret projection），不继承 daemon 环境，' +
      '超时 SIGKILL、stdout 只收 256KB envelope。不能走 runAgentProcess：adapter 非 agent 会话，' +
      '需要空环境与 sink-cwd 语义。',
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

/**
 * 一份源码里的进程起点命中数。**纯函数**——扫描与 RFC-317 T14 的「matcher 自证」
 * 共用它。findings G-07 点名过本文件的证伪方式：把 SPAWN_PATTERNS 改成匹配不到
 * 任何东西、再清空 ALLOWLIST，整个 suite 照绿——因为「实际命中表为空」与「全部
 * 合规」在断言层面同形。下面的 fixture 就是为了让那次证伪当场变红。
 */
function spawnHitsIn(source: string): number {
  let hits = 0
  for (const rawLine of source.split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (SPAWN_PATTERNS.some((re) => re.test(rawLine))) hits += 1
  }
  return hits
}

function countSpawnHits(filePath: string): number {
  return spawnHitsIn(readFileSync(filePath, 'utf8'))
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

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(walkTsFiles(SRC_ROOT).length).toBeGreaterThanOrEqual(300)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的进程起点喂给 **SPAWN_PATTERNS 那一份判据**。
//
// findings G-07 点名过本文件的证伪方式：「把 SPAWN_PATTERNS 的条目改成匹配不到任何
// 东西，再清空 ALLOWLIST，整个 suite 照绿」——因为实际命中表为空与全部合规同形。
// 下面每条 pattern 都配一个它必须抓到的典型写法，那次证伪于是当场变红。
//
// 覆盖是**逐条**的：新增一条 pattern 而不给样本会红（下面第一个 test），这样
// 「补了盲区却没证明补到位」不会悄悄溜过去——正是 T29 那次补 exec 族的教训。
describe('RFC-317 T14 —— matcher 自证：每条 spawn pattern 都必须抓到它的典型写法', () => {
  const SAMPLES: readonly string[] = [
    'const p = Bun.spawn({ cmd })',
    "const p = Bun['spawn']({ cmd })",
    'const r = Bun.spawnSync({ cmd })',
    "import { spawnSync } from 'node:child_process'",
    'const child = spawn(bin, argv)',
    "import cp from 'child_process'",
    'const out = await Bun.$`git status`',
    "execFile('git', ['status'], cb)",
    'const r = execSync(cmd)',
    'const w = fork(workerPath)',
  ]

  test('每条 pattern 至少被一个样本命中（新增 pattern 没配样本就红）', () => {
    const uncovered = SPAWN_PATTERNS.filter(
      (pattern) => !SAMPLES.some((sample) => pattern.test(sample)),
    ).map((pattern) => pattern.source)
    expect(uncovered, '这些 pattern 没有任何样本能证明它还咬得动').toEqual([])
  })

  test('每个样本都被扫描判据数到（判据被削弱时当场红）', () => {
    for (const sample of SAMPLES) {
      expect(spawnHitsIn(sample), `没抓到进程起点：${sample}`).toBe(1)
    }
  })

  test('注释行不算命中（否则规则没法在它适用的地方被解释）', () => {
    const commented = '// const p = Bun.spawn({ cmd })\n * fork(workerPath)\n/* execSync(cmd) */\n'
    expect(spawnHitsIn(commented)).toBe(0)
  })

  test('负回顾里刻意排除的方法名不误报（sqlite / RegExp 的 .exec）', () => {
    expect(spawnHitsIn('db.exec("PRAGMA journal_mode = WAL")\n')).toBe(0)
    expect(spawnHitsIn('const m = RE.exec(line)\n')).toBe(0)
  })

  test('完全不起进程的源码计为 0（判据不能宽到把普通代码也算成能力触点）', () => {
    expect(spawnHitsIn('export function add(a: number, b: number) {\n  return a + b\n}\n')).toBe(0)
  })
})

describe('RFC-317 T34（EK-01）—— 每个 spawn 站点的治理形态可断言', () => {
  const read = (rel: string): string => readFileSync(join(SRC_ROOT, rel), 'utf8')

  test('语料非空：allowlist 有条目、文件都在（否则下面几条零预言力）', () => {
    expect(Object.keys(ALLOWLIST).length).toBeGreaterThanOrEqual(10)
    const missing = Object.keys(ALLOWLIST).filter((rel) => !existsSync(join(SRC_ROOT, rel)))
    expect(missing, '死条目会让该文件未来新增的 spawn 被静默放过').toEqual([])
  })

  test('每条都声明了 governance，且 why 说得出所以然', () => {
    const bad = Object.entries(ALLOWLIST)
      .filter(([, entry]) => entry.why.trim().length < 20)
      .map(([rel]) => rel)
    expect(bad, 'why 太短——说不出为什么允许，就不该在表里').toEqual([])
  })

  test('process-group 站点必须真的自成进程组 + 整组杀', () => {
    const offenders: string[] = []
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      if (entry.governance !== 'process-group') continue
      const src = read(rel)
      const grouped = /detached:\s*true/.test(src)
      const treeKill = /killProcessTree\s*\(/.test(src) || /process\.kill\(\s*-/.test(src)
      if (!grouped || !treeKill) {
        offenders.push(`${rel}（detached=${grouped} 组杀=${treeKill}）`)
      }
    }
    expect(
      offenders,
      '声明按进程组治理，实际却没有。不 detached 时杀链只能杀到直接子进程，' +
        'fork 出来的孙进程会活下来继续写它本不该再碰的目录——这正是 EK-01 的形态',
    ).toEqual([])
  })

  test('short-lived 站点确实没有在自称进程组（自相矛盾的声明先红）', () => {
    const contradictory = Object.entries(ALLOWLIST)
      .filter(
        ([rel, entry]) => entry.governance === 'short-lived' && /detached:\s*true/.test(read(rel)),
      )
      .map(([rel]) => rel)
    expect(
      contradictory,
      '声明成 short-lived 却设了 detached——要么改成 process-group（并补上组杀），' +
        '要么这个 detached 是多余的',
    ).toEqual([])
  })
})
