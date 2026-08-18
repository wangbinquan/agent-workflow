// RFC-310 PR-5 T57 —— verification.run 的程序执行器（design §3.5）。
//
// 在 candidate 的一次性 disposable workspace 里逐 step 跑受管程序：exit code
// ∈ successExitCodes 才算过，**stdout 里的 "passed" 不是事实**；平台自己收
// evidence（file-glob 命中的产物 + stdout tail），大字节全部进 EvidenceStore
// （内容寻址 blob），receipt 只持 ref/digest。timeout 到点 TERM→KILL；输出
// bounded（尾部 64KB 环形保留，防 runaway 日志撑爆内存——Bun 管道无背压的
// 教训面）。networkProfileRef 首版不解释（2026-08-18 裁决：不做网络动作）。
//
// programRef 解析经注入的 resolver（首版 composition 给 `repo:<相对路径>`
// 形态——在 workspace 内执行仓库自带脚本，即 build/test 的主流形态；受管
// scripts 资源表随 PR-8 配置面，见 plan.md 交付注记）。

import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { platformSpawnOptionsForHost } from '@/util/platformExec'
import { sha256Hex } from '@/util/hash'
import type { VerificationProfileContent } from '../domain/verificationProfile'

type VerificationStep = VerificationProfileContent['steps'][number]
import type { EvidenceStore } from './evidenceStore'

export interface ResolvedVerificationProgram {
  /** argv[0] 是可执行体；`repo:` 形态解析为 workspace 内绝对路径。 */
  readonly argv: readonly string[]
}

export interface VerificationProgramResolver {
  resolve(input: {
    readonly programRef: string
    readonly argsRef: string | null
    readonly workspacePath: string
  }): ResolvedVerificationProgram | null
}

/** `repo:<相对路径>[@rev]` → workspace 内脚本（不存在/越界 ⇒ null）。 */
export function createRepoScriptResolver(): VerificationProgramResolver {
  return {
    resolve({ programRef, workspacePath }) {
      if (!programRef.startsWith('repo:')) return null
      const at = programRef.lastIndexOf('@')
      const rel = (at > 5 ? programRef.slice(5, at) : programRef.slice(5)).trim()
      if (
        rel.length === 0 ||
        rel.startsWith('/') ||
        rel.includes('\\') ||
        rel.includes('\0') ||
        rel.split('/').some((seg) => seg.length === 0 || seg === '.' || seg === '..')
      ) {
        return null
      }
      const abs = join(workspacePath, rel)
      if (!existsSync(abs)) return null
      return { argv: [abs] }
    },
  }
}

export interface VerificationStepResult {
  readonly stepId: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  /** stdout+stderr 尾部（bounded）的 evidence blob ref；空输出 ⇒ null。 */
  readonly outputTailRef: string | null
  readonly evidenceFiles: readonly {
    readonly selector: string
    readonly path: string
    readonly sha256: string
    readonly bytes: number
  }[]
}

export interface VerificationRunReceipt {
  readonly ok: boolean
  readonly stopPolicy: VerificationProfileContent['stopPolicy']
  readonly steps: readonly VerificationStepResult[]
  /** receipt 核心的 canonical digest（规则/审计引用）。 */
  readonly receiptDigest: string
}

const OUTPUT_TAIL_CAP = 64 * 1024

async function collectGlob(
  workspacePath: string,
  pattern: string,
  evidence: EvidenceStore,
): Promise<VerificationStepResult['evidenceFiles']> {
  const out: { selector: string; path: string; sha256: string; bytes: number }[] = []
  const glob = new Bun.Glob(pattern)
  for await (const rel of glob.scan({ cwd: workspacePath, dot: false, onlyFiles: true })) {
    // `.git`/`.agent-workflow` 不作为 verification 产物收集。
    if (rel.startsWith('.git/') || rel.startsWith('.agent-workflow/')) continue
    const blob = await evidence.putBlobFromFile(join(workspacePath, rel))
    out.push({
      selector: `file-glob:${pattern}`,
      path: rel,
      sha256: blob.sha256,
      bytes: blob.bytes,
    })
    if (out.length >= 64) break // bounded：单 selector 最多 64 个产物
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

async function runStep(
  deps: { readonly evidence: EvidenceStore; readonly resolver: VerificationProgramResolver },
  workspacePath: string,
  step: VerificationStep,
): Promise<VerificationStepResult> {
  const started = Date.now()
  const resolved = deps.resolver.resolve({
    programRef: step.programRef,
    argsRef: step.argsRef,
    workspacePath,
  })
  if (resolved === null) {
    return {
      stepId: step.stepId,
      ok: false,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      outputTailRef: null,
      evidenceFiles: [],
    }
  }

  // stdout/stderr 直连文件：管道会被脚本的长命孙进程钉住不闭合（timeout
  // 场景实测挂死），文件后端让 exited 即定稿；tail 从文件尾截 64KB。
  const outDir = mkdtempSync(join(tmpdir(), 'aw-verify-out-'))
  const stdoutFile = join(outDir, 'stdout.log')
  const stderrFile = join(outDir, 'stderr.log')
  const proc = Bun.spawn({
    ...platformSpawnOptionsForHost(),
    cmd: [...resolved.argv],
    cwd: workspacePath,
    stdin: 'ignore',
    stdout: Bun.file(stdoutFile),
    stderr: Bun.file(stderrFile),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
    },
  })
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill('SIGTERM')
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, 2_000).unref?.()
  }, step.timeoutMs)
  const exitCode = await proc.exited
  clearTimeout(killer)

  let outputTailRef: string | null = null
  try {
    const tails: Uint8Array[] = []
    for (const file of [stdoutFile, stderrFile]) {
      const st = lstatSync(file, { throwIfNoEntry: false })
      if (!st || st.size === 0) continue
      const fd = Bun.file(file)
      const from = Math.max(0, st.size - OUTPUT_TAIL_CAP)
      tails.push(new Uint8Array(await fd.slice(from, st.size).arrayBuffer()))
    }
    const total = tails.reduce((n, t) => n + t.byteLength, 0)
    if (total > 0) {
      const combined = new Uint8Array(total)
      let offset = 0
      for (const t of tails) {
        combined.set(t, offset)
        offset += t.byteLength
      }
      const file = join(outDir, 'output.log')
      writeFileSync(file, combined)
      outputTailRef = (await deps.evidence.putBlobFromFile(file)).sha256
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }

  const evidenceFiles: VerificationStepResult['evidenceFiles'][number][] = []
  for (const selector of step.evidenceSelectors) {
    if (selector.kind === 'file-glob') {
      evidenceFiles.push(...(await collectGlob(workspacePath, selector.value, deps.evidence)))
    }
    // stdout-tail selector：outputTailRef 已覆盖（value 只影响展示截取，首版
    // 统一 64KB cap——更小的 tail 由读侧裁剪）。
  }

  const ok = !timedOut && step.successExitCodes.includes(exitCode)
  return {
    stepId: step.stepId,
    ok,
    exitCode,
    timedOut,
    durationMs: Date.now() - started,
    outputTailRef,
    evidenceFiles,
  }
}

/**
 * 逐 step 串行执行（maxParallel 首版按 1 处理——verification 的确定性优先，
 * 并行化随后续批次）；stopPolicy=first-failure 时首个失败即停。
 */
export async function runVerificationProfile(
  deps: { readonly evidence: EvidenceStore; readonly resolver: VerificationProgramResolver },
  input: { readonly workspacePath: string; readonly profile: VerificationProfileContent },
): Promise<VerificationRunReceipt> {
  const steps: VerificationStepResult[] = []
  for (const step of input.profile.steps) {
    const result = await runStep(deps, input.workspacePath, step)
    steps.push(result)
    if (!result.ok && input.profile.stopPolicy === 'first-failure') break
  }
  const ok = steps.length === input.profile.steps.length && steps.every((s) => s.ok)
  const receiptDigest = sha256Hex(
    JSON.stringify(
      steps.map((s) => ({
        stepId: s.stepId,
        ok: s.ok,
        exitCode: s.exitCode,
        timedOut: s.timedOut,
        outputTailRef: s.outputTailRef,
        evidenceFiles: s.evidenceFiles,
      })),
    ),
  )
  return { ok, stopPolicy: input.profile.stopPolicy, steps, receiptDigest }
}
