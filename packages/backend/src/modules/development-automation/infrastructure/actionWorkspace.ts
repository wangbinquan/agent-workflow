// RFC-310 PR-3 T37 —— action workspace 物化与整树回退。
//
// workspace = baseline clone（exact sha）+ RFC-308 exclude（`.agent-workflow/`
// 进 `.git/info/exclude`）+ 可选 seed overlay（平台写入的上传落点）+ 只读
// evidence bundle mounts。fresh-session 重跑走同一函数从 exact 输入重建，
// businessTreeDigest（排除 .git/.agent-workflow 的内容 digest）byte-identical
// 是回退合同（PR-0 B4 口径的生产化）。discard 是整树删除——绝不 git reset。

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runGit } from '@/util/git'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type { EvidenceStore } from './evidenceStore'

export interface WorkspaceDeps {
  readonly evidence: EvidenceStore
  readonly seedsRoot: string
  /**
   * workspace 宿主根。生产必须落 appHome 之下（RFC-308 exclude participant
   * 对平台家外的 worktree 抛 owner-mismatch，task 启动会失败——PR-4 fork J
   * 实测）；缺省 tmpdir 仅供纯 workspace 单测。
   */
  readonly workspacesRoot?: string
}

export interface MaterializeInput {
  readonly baselineRepoPath: string
  readonly baselineSha: string
  /** placement 的 seedChangeRef（= planDigest）；null = 无上传 seed。 */
  readonly seedRef: string | null
  readonly bundles: readonly { readonly bundleId: string; readonly mountPath: string }[]
}

export interface MaterializedWorkspace {
  readonly workspacePath: string
  readonly businessTreeDigest: string
}

/** 业务树 digest：排除 .git 与 .agent-workflow 的稳定内容 hash。 */
export function businessTreeDigestOf(root: string): string {
  const hash = createHash('sha256')
  const files: string[] = []
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    const st = lstatSync(abs)
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        const childRel = rel === '' ? name : `${rel}/${name}`
        if (childRel === '.git' || childRel === PLATFORM_WORKSPACE_DIR) continue
        walk(childRel)
      }
      return
    }
    if (st.isFile()) files.push(rel)
  }
  walk('')
  for (const rel of files.sort()) {
    hash.update(`${rel}\n`)
    hash.update(
      createHash('sha256')
        .update(readFileSync(join(root, rel)))
        .digest('hex'),
    )
    hash.update('\n')
  }
  return hash.digest('hex')
}

function copyTree(srcRoot: string, destRoot: string): void {
  const walk = (rel: string): void => {
    const abs = rel === '' ? srcRoot : join(srcRoot, rel)
    const st = lstatSync(abs)
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(rel === '' ? name : `${rel}/${name}`)
      return
    }
    if (st.isFile()) {
      const dest = join(destRoot, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(abs, dest)
      chmodSync(dest, st.mode & 0o777)
    }
  }
  if (existsSync(srcRoot)) walk('')
}

export async function materializeActionWorkspace(
  deps: WorkspaceDeps,
  input: MaterializeInput,
): Promise<MaterializedWorkspace> {
  let parent: string
  if (deps.workspacesRoot === undefined) {
    parent = mkdtempSync(join(tmpdir(), 'aw-action-ws-'))
  } else {
    mkdirSync(deps.workspacesRoot, { recursive: true })
    parent = mkdtempSync(join(deps.workspacesRoot, 'action-'))
  }
  const ws = join(parent, 'ws')
  const clone = await runGit(parent, [
    'clone',
    '--no-hardlinks',
    '--quiet',
    input.baselineRepoPath,
    ws,
  ])
  if (clone.exitCode !== 0) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`workspace clone failed: ${clone.stderr.slice(0, 300)}`)
  }
  const checkout = await runGit(ws, ['checkout', '--quiet', '--detach', input.baselineSha])
  if (checkout.exitCode !== 0) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`workspace checkout failed: ${checkout.stderr.slice(0, 300)}`)
  }
  // Agent actions never publish Git themselves. Remove the inherited clone
  // remote before execution; the platform's later commit/push stage uses the
  // mission source-control context, not this disposable action workspace.
  const removeOrigin = await runGit(ws, ['remote', 'remove', 'origin'])
  if (removeOrigin.exitCode !== 0) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`workspace remote removal failed: ${removeOrigin.stderr.slice(0, 300)}`)
  }
  // RFC-308：平台运行物整目录排除（先于任何快照/写入）。
  mkdirSync(join(ws, '.git', 'info'), { recursive: true })
  writeFileSync(join(ws, '.git', 'info', 'exclude'), `${PLATFORM_WORKSPACE_DIR}/\n`)

  if (input.seedRef !== null) {
    copyTree(join(deps.seedsRoot, input.seedRef), ws)
  }
  for (const bundle of input.bundles) {
    deps.evidence.materializeBundle(bundle.bundleId, join(ws, bundle.mountPath))
  }
  return { workspacePath: ws, businessTreeDigest: businessTreeDigestOf(ws) }
}

/** 整树回退：废弃 workspace（含其父临时目录）。 */
export function discardWorkspace(workspacePath: string): void {
  rmSync(dirname(workspacePath), { recursive: true, force: true })
}
