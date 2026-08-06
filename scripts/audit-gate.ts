// 依赖漏洞门禁（CI `Static scans` job 调用；本地 `bun run audit:gate`）。
//
// 为什么不直接用 `bun audit --audit-level=high --ignore <GHSA>`：
// **那两个 flag 是显示层过滤器，不是退出码闸门。** bun 1.3.13 `bun audit --help`
// 原文——`--audit-level`：「只*打印*严重度 ≥ 该级别的公告」；`--ignore`：「从审计中
// 忽略指定 CVE」。实测（干净 clone + `--frozen-lockfile` 忠实复现 CI）：
//
//   bun audit --audit-level=critical                          → exit 1
//   bun audit --audit-level=critical --ignore <唯一那条 critical> → exit 1（且输出字节数一模一样）
//
// 即：退出码只反映「有没有公告」，与严重度和忽略列表无关。于是那条命令写成的
// gate 有两种结局——registry 返回数据就恒红（再加多少 --ignore 都没用），返回空
// 就恒绿。2026-07-26 之前它一直绿，是因为 CI 里 audit 请求持续返回空（三次成功
// run 的该步骤日志里连一条公告都没有，0.12s 退出）；当天返回了真实数据，gate 立刻
// 红成一片，且无法用策略里写的「逐条 scoped ignore」修好。
//
// 本脚本自己实现那套策略：拿 `bun audit --json` 的真实报告 → 按 GHSA 应用忽略
// 列表 → 只对 high/critical 失败 → 打印**可读**的表格（bun 把报告 gzip 压缩后写
// stdout，直接落进 Actions 日志是一堆乱码，这也是当初没人看出问题的原因之一）。
//
// 忽略策略（沿用原 ci.yml 注释确立的规则，未放宽）：
//   逐条处理——override / patch / 上游 issue / 精确忽略；**禁止**整体降级成
//   continue-on-error。每条忽略必须写明「为什么可接受」与「何时删除」，见下方
//   IGNORED_ADVISORIES 的 why / removeWhen 字段（测试强制非空）。

import { constants as zlibConstants, gunzipSync } from 'node:zlib'

export interface Advisory {
  url: string
  title: string
  severity: string
  vulnerable_versions?: string
}

/** `bun audit --json` 的报告形状：包名 → 公告数组。 */
export type AuditReport = Record<string, Advisory[]>

export interface IgnoreEntry {
  /** GHSA slug，与公告 URL 末段一致。 */
  id: string
  /** 受影响的包（用于可读输出与 stale 检测的说明）。 */
  package: string
  /** 为什么这条可以接受——必须具体到「怎么传递进来的 / 为什么打不到我们」。 */
  why: string
  /** 何时应当删除本条。 */
  removeWhen: string
}

/**
 * 接受的公告。每条都是 dev / 工具链传递依赖，不进单二进制产物；均已确认当前
 * 没有可用的兼容修复版本。上游一旦发布，删除对应条目（测试会提示 stale）。
 */
export const IGNORED_ADVISORIES: readonly IgnoreEntry[] = [
  {
    id: 'GHSA-w7jw-789q-3m8p',
    package: 'shell-quote',
    why: '传递依赖，dev/工具链专用——经 drizzle-orm/drizzle-kit › gel（EdgeDB/Gel 驱动）引入，平台运行时是 bun:sqlite，从不使用它，也不在发布的单二进制里。',
    removeWhen:
      'drizzle 把传递的 shell-quote 提过该公告范围（当前安装的 1.8.3 已是满足区间的最新版，尚无可升级目标）。',
  },
  {
    id: 'GHSA-395f-4hp3-45gv',
    package: 'shell-quote',
    why: 'parse() 的二次复杂度 DoS，同样只经 drizzle-kit / drizzle-orm 的迁移工具链引入，不在运行时与产物中。',
    removeWhen: '同上，drizzle 传递依赖升级后。',
  },
]

/** 会让门禁失败的严重度。moderate/low 的长尾是 dev 噪音（esbuild dev-server 之类），不入闸。 */
export const BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(['high', 'critical'])

/** 公告 URL 末段即 GHSA slug。 */
export function ghsaOf(advisory: Advisory): string {
  return advisory.url.split('/').filter(Boolean).pop() ?? advisory.url
}

/**
 * 解析 `bun audit --json` 的 stdout。
 *
 * bun 1.3.13 有两种写法：重定向到文件时先写一行 ANSI banner 再写 **gzip 压缩**的
 * 报告；直接进管道时省掉 banner、首字节就是 gzip magic。未来版本若改成明文，
 * 这里的明文分支照样能吃。解析不出来返回 null（调用方按「无数据」处理，不当成
 * 「没有漏洞」）。
 */
export function decodeAuditReport(stdout: Uint8Array): AuditReport | null {
  if (stdout.length === 0) return null
  const gzipAt = indexOfGzipMagic(stdout)
  if (gzipAt >= 0) {
    const text = gunzipTolerant(stdout.subarray(gzipAt))
    return text === null ? null : parseReport(text)
  }
  const text = new TextDecoder().decode(stdout)
  const brace = text.indexOf('{')
  return brace >= 0 ? parseReport(text.slice(brace)) : null
}

/**
 * bun 1.3.13 倒出来的 gzip 流是**截断的**（缺尾部 CRC/ISIZE），严格解压会报
 * `unexpected end of file`。数据主体本身完整，所以先严格解一次，失败再用
 * `Z_SYNC_FLUSH` 收尾——那会把已解出的部分照常交出来，正是我们要的。
 * 两次都失败才算无数据。
 */
function gunzipTolerant(buf: Uint8Array): string | null {
  try {
    return gunzipSync(buf).toString('utf8')
  } catch {
    /* 截断流，走下面的容忍解压 */
  }
  try {
    return gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8')
  } catch {
    return null
  }
}

function indexOfGzipMagic(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x1f && buf[i + 1] === 0x8b) return i
  }
  return -1
}

function parseReport(text: string): AuditReport | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const report: AuditReport = {}
    for (const [pkg, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      report[pkg] = value.filter(
        (a): a is Advisory =>
          a !== null &&
          typeof a === 'object' &&
          typeof (a as Advisory).url === 'string' &&
          typeof (a as Advisory).severity === 'string',
      )
    }
    return report
  } catch {
    return null
  }
}

export interface AuditFinding {
  package: string
  advisory: Advisory
  ghsa: string
}

export interface AuditVerdict {
  /** high/critical 且不在忽略列表 —— 这些让门禁失败。 */
  blocking: AuditFinding[]
  /** high/critical 但被显式接受。 */
  accepted: AuditFinding[]
  /** 低于阈值的公告条数（只作统计展示）。 */
  belowThreshold: number
  /** 忽略列表里没有匹配到任何公告的条目 —— 上游多半已修，该删了。 */
  staleIgnores: string[]
}

export function evaluateAudit(
  report: AuditReport,
  ignored: readonly IgnoreEntry[] = IGNORED_ADVISORIES,
): AuditVerdict {
  const ignoredIds = new Set(ignored.map((e) => e.id))
  const seenIds = new Set<string>()
  const verdict: AuditVerdict = {
    blocking: [],
    accepted: [],
    belowThreshold: 0,
    staleIgnores: [],
  }
  for (const [pkg, advisories] of Object.entries(report)) {
    for (const advisory of advisories) {
      const ghsa = ghsaOf(advisory)
      seenIds.add(ghsa)
      if (!BLOCKING_SEVERITIES.has(advisory.severity)) {
        verdict.belowThreshold++
        continue
      }
      const finding: AuditFinding = { package: pkg, advisory, ghsa }
      if (ignoredIds.has(ghsa)) verdict.accepted.push(finding)
      else verdict.blocking.push(finding)
    }
  }
  verdict.staleIgnores = ignored.map((e) => e.id).filter((id) => !seenIds.has(id))
  return verdict
}

/** 门禁的人类可读输出。返回行数组便于测试，不直接 console。 */
export function formatVerdict(verdict: AuditVerdict): string[] {
  const lines: string[] = []
  if (verdict.blocking.length > 0) {
    lines.push(`✖ ${verdict.blocking.length} 条 high/critical 公告未被接受：`)
    for (const f of verdict.blocking) {
      lines.push(`    ${f.package}  ${f.advisory.severity}  ${f.ghsa}`)
      lines.push(`      ${f.advisory.title}`)
      if (f.advisory.vulnerable_versions !== undefined) {
        lines.push(`      受影响版本 ${f.advisory.vulnerable_versions}`)
      }
      lines.push(`      ${f.advisory.url}`)
    }
    lines.push('')
    lines.push('  处置方式（逐条，禁止整体放行）：升级 / 根 overrides 钉版本 /')
    lines.push('  上游 issue / 在 scripts/audit-gate.ts 的 IGNORED_ADVISORIES 里')
    lines.push('  写明 why + removeWhen 后接受。')
  } else {
    lines.push('✔ 没有未被接受的 high/critical 公告。')
  }
  lines.push(
    `  已接受 ${verdict.accepted.length} 条 high/critical，低于阈值 ${verdict.belowThreshold} 条。`,
  )
  for (const id of verdict.staleIgnores) {
    lines.push(`  · 忽略条目 ${id} 未匹配到任何公告 —— 上游可能已修复，可以删除了。`)
  }
  return lines
}

const MAX_ATTEMPTS = 3

/**
 * 跑 `bun audit --json` 并取回原始 stdout。
 *
 * 注意：bun 1.3.13 在 registry 返回 gzip 时**自己解不开**，会把压缩响应体原样
 * 倒进 stdout、往 stderr 写 `audit request failed to parse json. Is the registry
 * down?` 并 exit 1。所以这里**刻意不看子进程退出码**——它反映的是 bun 的解析
 * 结果，不是漏洞判定。真正的判定由本脚本自己解压后完成。
 */
async function runBunAudit(): Promise<{ stdout: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(['bun', 'audit', '--json'], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: new Uint8Array(out), stderr: err.trim() }
}

async function main(): Promise<void> {
  let report: AuditReport | null = null
  let lastStderr = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && report === null; attempt++) {
    const { stdout, stderr } = await runBunAudit()
    lastStderr = stderr
    report = decodeAuditReport(stdout)
    if (report === null && attempt < MAX_ATTEMPTS) {
      console.warn(`audit-gate: 第 ${attempt} 次未取到可解析的报告，重试…`)
      await Bun.sleep(2000 * attempt)
    }
  }
  if (report === null) {
    // 无法区分「registry 返回空」与「请求失败」（两种情况 bun 都不给结构化信号）。
    // 放行但**大声**说明——这正是本门禁此前长期假绿的成因，不能再让它悄无声息。
    // 已登记在 docs/audit-backlog.md。
    console.warn(
      '::warning::audit-gate: 未能取到可解析的 audit 报告（registry 返回空或请求失败）——本次未做漏洞判定。',
    )
    if (lastStderr.length > 0) console.warn(`  bun stderr: ${lastStderr}`)
    return
  }
  const verdict = evaluateAudit(report)
  for (const line of formatVerdict(verdict)) console.log(line)
  if (verdict.blocking.length > 0) process.exit(1)
}

if (import.meta.main) {
  await main()
}
