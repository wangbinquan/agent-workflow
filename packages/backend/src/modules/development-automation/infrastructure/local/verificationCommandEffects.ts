import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import { killProcessTree, reapDetachedGroup } from '@/util/process'
import type { EvidenceArtifactPort } from '../../application/ports/evidenceArtifacts'
import type {
  VerificationCommandEffects,
  VerificationCommandEffectsFactory,
  VerificationStepResult,
  VerificationProgramRef,
} from '../../application/ports/verificationCommandEffects'

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

/** TERM 之后给整组的宽限（与改造前的 2s 逐字一致）。 */
const VERIFICATION_KILL_GRACE_MS = 2_000
/** 超时路径上等整组死透的上限——有界，绝不无限等。 */
const VERIFICATION_REAP_WINDOW_MS = 2_000

const OUTPUT_TAIL_CAP = 64 * 1024

async function collectGlob(
  workspacePath: string,
  pattern: string,
  evidence: EvidenceArtifactPort,
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

/** Keep the original dependency receivers and their read positions. */
export function createLocalVerificationCommandEffects(deps: {
  readonly evidence: EvidenceArtifactPort
  readonly resolver: VerificationProgramResolver
}): VerificationCommandEffects {
  const programs = new WeakMap<VerificationProgramRef, ResolvedVerificationProgram>()
  return {
    resolveProgram(input) {
      const resolved = deps.resolver.resolve({
        programRef: input.programRef,
        argsRef: input.argsRef,
        workspacePath: input.workspaceRef,
      })
      if (resolved === null) return null
      const reference = Object.freeze({})
      programs.set(reference, resolved)
      return reference
    },
    async execute({ program, workspaceRef: workspacePath, step }) {
      const resolved = programs.get(program)
      if (resolved === undefined) throw new Error('verification-program-owner-mismatch')
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
        // RFC-317 T35（EK-01）—— 自成进程组。
        //
        // 这里跑的是 build / test 程序：npm、bun、cargo——它们**存在的意义就是 fork 子进程**。
        // 不 detached 时，下面那条杀链只能杀到直接子进程，孙进程会活下来；而本函数随后
        // `rmSync(outDir)`、调用方紧接着丢弃 workspace——一个还在往里写文件的幸存孙进程，
        // 正是 managedProcess 里那句注释说的 "Without it a fork()ed grandchild survives
        // every kill we send"。
        detached: true,
      })
      let timedOut = false
      const killer = setTimeout(() => {
        timedOut = true
        // 整组杀：TERM 宽限 → KILL，与平台受管进程同一条杀链（util/process.killProcessTree）。
        // 改造前是 `proc.kill('SIGTERM')` → 2s → `proc.kill('SIGKILL')`，只作用于直接子进程。
        killProcessTree(proc.pid, 'SIGTERM')
        setTimeout(() => killProcessTree(proc.pid, 'SIGKILL'), VERIFICATION_KILL_GRACE_MS).unref?.()
      }, step.timeoutMs)
      const exitCode = await proc.exited
      clearTimeout(killer)
      // 有界收尸：超时路径上组里可能还有孙进程没死透，等一个有上限的窗口再往下走——
      // 否则 rmSync(outDir) 会和它们的写入赛跑。
      if (timedOut) await reapDetachedGroup(proc.pid, VERIFICATION_REAP_WINDOW_MS)

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

      return { exitCode, timedOut, outputTailRef }
    },
    collectFiles({ workspaceRef, pattern }) {
      return collectGlob(workspaceRef, pattern, deps.evidence)
    },
  }
}

export function createLocalVerificationCommandEffectsFactory(): VerificationCommandEffectsFactory {
  return {
    create(input) {
      return createLocalVerificationCommandEffects({
        evidence: input.evidence,
        resolver: createRepoScriptResolver(),
      })
    },
  }
}
