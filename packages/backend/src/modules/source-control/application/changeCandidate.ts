// RFC-310 PR-4 T48 —— 从 pinned baseline + 已验证 overlay 派生 immutable
// ChangeCandidate（design §9.1；本批不 commit/push——发布链归 PR-5）。
//
// 独立 diff 原则（§7.6 第 6 条）：不复用 Agent workspace 的 .git 状态，也不信
// 其自报 changed paths——在 source-control 自己的临时 clone 里重放
// baseline → 清业务树 → 拷 overlay → `git add -A` → `git diff --cached`
// 与 `git write-tree`。tree oid 即 candidate 树的内容寻址身份，同输入必
// byte-identical（determinism 由测试锁定）。overlay 里的 symlink 一律拒收
// （workspace validator 之外的纵深防御：candidate 树只承载常规文件）。

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runGit as defaultRunGit } from '@/util/git'
import { sha256Hex } from '@/util/hash'
import {
  CANDIDATE_PLATFORM_DIR,
  candidateReceiptRef,
  changedPathSet,
  checkForbiddenCandidatePaths,
  verifyUploadLineage,
  type ChangeCandidateReceipt,
  type ChangedPathSummary,
  type UploadLineageEntry,
} from '../domain/changeCandidate'
import { parseNameStatusZ, type RepositoryGit } from './repositoryCommit'

export interface DeriveChangeCandidateInput {
  readonly baselineRepoPath: string
  readonly baselineSha: string
  /** 已通过 workspace validator 的业务树根（`.git` 不拷；平台目录若在其中会在 diff 层被固定阻断）。 */
  readonly overlayRoot: string
  readonly excludePolicyDigest: string
  readonly agentOutcomeRef: string
  readonly protectedRoots?: readonly string[]
  readonly uploadPlan?: {
    readonly planDigest: string
    readonly entries: readonly UploadLineageEntry[]
  } | null
  /** Upload entries are already present in this platform-published baseline. */
  readonly uploadsAlreadyPublished?: boolean
  readonly runGit?: RepositoryGit
}

export type DeriveChangeCandidateResult =
  | { readonly ok: true; readonly receipt: ChangeCandidateReceipt }
  | {
      readonly ok: false
      readonly code:
        | 'candidate-workspace-failed'
        | 'candidate-empty'
        | 'candidate-forbidden-path'
        | 'overlay-symlink'
        | 'upload-entry-missing-from-diff'
        | 'upload-preserve-digest-mismatch'
        | 'upload-editable-target-missing'
        | 'upload-already-present-changed'
      readonly detail: string
    }

function copyOverlay(srcRoot: string, destRoot: string): { symlink: string | null } {
  let symlink: string | null = null
  const walk = (rel: string): void => {
    if (symlink !== null) return
    const abs = rel === '' ? srcRoot : join(srcRoot, rel)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) {
      symlink = rel
      return
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        const childRel = rel === '' ? name : `${rel}/${name}`
        // `.agent-workflow/` 是平台运行物（evidence mounts 等），按 RFC-308
        // exclude 语义**不属于 overlay 业务内容**，拷贝即排除——它出现在
        // workspace 是平台自己放的，不代表业务变更。固定阻断面仍然保留：
        // 若 baseline 里 tracked 了平台路径而 overlay 缺失（或任何原因让它
        // 进入 diff），checkForbiddenCandidatePaths 照样拒（纵深防御）。
        if (childRel === '.git' || childRel === CANDIDATE_PLATFORM_DIR) continue
        walk(childRel)
      }
      return
    }
    if (st.isFile()) {
      const dest = join(destRoot, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(abs, dest)
      chmodSync(dest, st.mode & 0o777)
    }
  }
  walk('')
  return { symlink }
}

/** 清掉 clone 里 baseline 的业务文件（保留 .git）：overlay 是全量业务树，缺席即删除。 */
function clearBusinessTree(root: string): void {
  for (const name of readdirSync(root)) {
    if (name === '.git') continue
    rmSync(join(root, name), { recursive: true, force: true })
  }
}

/**
 * 派生与发布共用的 stage 半：clone baseline → 清业务树 → 拷 overlay（排除
 * `.git`/`.agent-workflow`、拒 symlink）→ add（gitignore 语义 + 上传目标
 * add -f）→ write-tree。发布侧（deliverCandidate）用它对 pinned receipt 重放
 * 对拍（§9.2「commit 前重新 preview；prepare 后 workspace 改变 = digest
 * mismatch 整个作废」）——两处 add 规则漂移会让重放恒 mismatch，所以只有
 * 这一份实现。调用方负责 cleanup()（成功路径也要）。
 */
export async function stageCandidateTree(input: {
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly overlayRoot: string
  readonly uploadPlan?: {
    readonly entries: readonly Pick<UploadLineageEntry, 'targetPath' | 'disposition' | 'fileMode'>[]
  } | null
  readonly runGit?: RepositoryGit
}): Promise<
  | { readonly ok: true; readonly ws: string; readonly treeOid: string; cleanup(): void }
  | {
      readonly ok: false
      readonly code: 'candidate-workspace-failed' | 'overlay-symlink'
      readonly detail: string
    }
> {
  const runGit = input.runGit ?? defaultRunGit
  const parent = mkdtempSync(join(tmpdir(), 'aw-candidate-'))
  const ws = join(parent, 'ws')
  const cleanup = (): void => rmSync(parent, { recursive: true, force: true })
  const fail = (
    code: 'candidate-workspace-failed' | 'overlay-symlink',
    detail: string,
  ): { ok: false; code: typeof code; detail: string } => {
    cleanup()
    return { ok: false, code, detail }
  }
  const clone = await runGit(parent, [
    'clone',
    '--no-hardlinks',
    '--quiet',
    input.baselineRepoPath,
    ws,
  ])
  if (clone.exitCode !== 0) {
    return fail('candidate-workspace-failed', clone.stderr.slice(0, 300))
  }
  const checkout = await runGit(ws, ['checkout', '--quiet', '--detach', input.baselineSha])
  if (checkout.exitCode !== 0) {
    return fail('candidate-workspace-failed', checkout.stderr.slice(0, 300))
  }
  clearBusinessTree(ws)
  const copied = copyOverlay(input.overlayRoot, ws)
  if (copied.symlink !== null) return fail('overlay-symlink', copied.symlink)
  // 普通业务文件尊重仓库 .gitignore（Agent 的构建垃圾不进 candidate）；
  // 上传目标逐个 `add -f`——§9.2：非 already-present 上传不得因 ignore 消失。
  const add = await runGit(ws, ['add', '-A', '.'])
  if (add.exitCode !== 0) return fail('candidate-workspace-failed', add.stderr.slice(0, 300))
  for (const entry of input.uploadPlan?.entries ?? []) {
    if (entry.disposition === 'already-present') continue
    // 目标缺失不在这里定性——交给 lineage 验证给出 typed code。
    const st = lstatSync(join(ws, entry.targetPath), { throwIfNoEntry: false })
    if (!st || !st.isFile()) continue
    chmodSync(join(ws, entry.targetPath), entry.fileMode === 'executable' ? 0o755 : 0o644)
    const forced = await runGit(ws, ['add', '-f', '--', entry.targetPath])
    if (forced.exitCode !== 0) {
      return fail('candidate-workspace-failed', forced.stderr.slice(0, 300))
    }
    // `core.filemode=false` (notably Windows) must not erase the explicit
    // repository upload contract. Pin the index mode independently of host FS.
    const indexedMode = await runGit(ws, [
      'update-index',
      entry.fileMode === 'executable' ? '--chmod=+x' : '--chmod=-x',
      '--',
      entry.targetPath,
    ])
    if (indexedMode.exitCode !== 0) {
      return fail('candidate-workspace-failed', indexedMode.stderr.slice(0, 300))
    }
  }
  const writeTree = await runGit(ws, ['write-tree'])
  if (writeTree.exitCode !== 0) {
    return fail('candidate-workspace-failed', writeTree.stderr.slice(0, 300))
  }
  return { ok: true, ws, treeOid: writeTree.stdout.trim(), cleanup }
}

export async function deriveChangeCandidate(
  input: DeriveChangeCandidateInput,
): Promise<DeriveChangeCandidateResult> {
  const runGit = input.runGit ?? defaultRunGit
  const staged = await stageCandidateTree(input)
  if (!staged.ok) return staged
  const ws = staged.ws
  try {
    // --no-renames：lineage 验证按 A/M/D 对拍 target path，rename 折叠会让
    // created entry 从 changed 集合里消失。
    const diff = await runGit(ws, [
      'diff',
      '--cached',
      '--name-status',
      '--no-renames',
      '-z',
      input.baselineSha,
    ])
    if (diff.exitCode !== 0) {
      return { ok: false, code: 'candidate-workspace-failed', detail: diff.stderr.slice(0, 300) }
    }
    const groups = parseNameStatusZ(diff.stdout)
    const summary: ChangedPathSummary = {
      added: groups
        .filter((g) => g.status.startsWith('A'))
        .map((g) => g.paths[0]!)
        .sort(),
      modified: groups
        .filter((g) => g.status.startsWith('M') || g.status.startsWith('T'))
        .map((g) => g.paths[0]!)
        .sort(),
      deleted: groups
        .filter((g) => g.status.startsWith('D'))
        .map((g) => g.paths[0]!)
        .sort(),
    }
    if (
      summary.added.length === 0 &&
      summary.modified.length === 0 &&
      summary.deleted.length === 0
    ) {
      return { ok: false, code: 'candidate-empty', detail: 'no delta against pinned baseline' }
    }

    const violations = checkForbiddenCandidatePaths(summary, input.protectedRoots ?? [])
    if (violations.length > 0) {
      const first = violations[0]!
      return {
        ok: false,
        code: 'candidate-forbidden-path',
        detail: `${first.reason}: ${first.path}`,
      }
    }

    let uploadLineage: ChangeCandidateReceipt['uploadLineage'] = null
    if (input.uploadPlan != null) {
      const verdict = verifyUploadLineage(input.uploadPlan.entries, {
        changed: changedPathSet(summary),
        alreadyPublished: input.uploadsAlreadyPublished,
        blobSha256Of: (targetPath) => {
          const abs = join(ws, targetPath)
          const st = lstatSync(abs, { throwIfNoEntry: false })
          if (!st || !st.isFile()) return null
          return sha256Hex(readFileSync(abs))
        },
      })
      if (!verdict.ok) {
        return { ok: false, code: verdict.code, detail: verdict.targetPath }
      }
      uploadLineage = {
        planDigest: input.uploadPlan.planDigest,
        finalDigests: verdict.finalDigests,
      }
    }

    const core = {
      baselineSnapshotRef: `git:${input.baselineSha}`,
      treeOid: staged.treeOid,
      changed: summary,
      excludePolicyDigest: input.excludePolicyDigest,
      agentOutcomeRef: input.agentOutcomeRef,
      uploadLineage,
    }
    return { ok: true, receipt: { candidateRef: candidateReceiptRef(core), ...core } }
  } finally {
    staged.cleanup()
  }
}
