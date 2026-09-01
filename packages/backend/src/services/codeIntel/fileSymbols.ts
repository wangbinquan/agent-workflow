// RFC-258 §2.1 — one file's symbol table, for the full-file view's anchor bar,
// the baseline engine's target-file lookup, and the graph→source position
// resolution (gate F-06). Reuses the file-content read primitives (contained
// worktree read / base blob) and the baseline extractor verbatim; the ONLY new
// logic is mapping extractor state onto the honest `status` field (F-09).

import { basename } from 'node:path'
import { parseRepoKeyWire, type FileSymbolsResult, type SymbolNode } from '@agent-workflow/shared'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { readBlobAtRef } from '@/util/git'
import type {
  CodeWorkspaceRead,
  CodeWorkspaceTask,
} from '@/modules/code-capability/application/ports/codeWorkspaceRead'
import { canonicalRepoKeys } from '@/services/repoLabels'
import { FILE_CONTENT_MAX_BYTES, openContainedFile } from '@/services/worktreeFileContent'
import { resolveLang } from '@/services/structuralDiff/lang/grammars'
import { extractSymbols } from '@/services/structuralDiff/lang/extract'

export interface FileSymbolsQuery {
  path: string
  side: 'base' | 'worktree'
  /** Wire-form repo key ('.' = root repo, F-04); required for multi-repo. */
  repo?: string
}

type LoadedTask = CodeWorkspaceTask

/** Resolve the (worktreePath, baseCommit) pair the query targets. Mirrors
 *  getTaskFileContent's repo selection but keyed by the RFC-248 canonical
 *  mount-path key (wire '.') instead of the legacy label (F-04). */
export function resolveRepoTarget(
  task: LoadedTask,
  repoWire: string | undefined,
): { worktreePath: string; baseCommit: string | null } {
  // RFC-287 G7：任务可能**还没有工作树**（仓库准备移到任务行落库之后，准备窗口内
  // `worktreePath` 是空串）。空根往下传会出两种事故，且都不是理论：
  //   · `openContainedFile` 里 `resolve('')` = daemon 的 cwd ⇒ 符号表接口把 daemon
  //     自己的源码吐出来（实测 `?path=src/main.ts` 返回 17 个符号）；
  //   · deep 模式把它当 `cwd` 交给 SCIP indexer 子进程 ⇒ `Bun.spawn({cwd:''})`
  //     回落进程 cwd，于是在 daemon 工作目录上跑一次完整索引并缓存、对外应答。
  // 判在这个**共同入口**：deep code-intel 与 fileSymbols 两条路都从这里取根。
  //
  // 注意单仓分支尤其危险：延后准备时 `repoCount` 恒为 1（回填后才变 N），所以多仓
  // 任务在窗口内也走这一支，攻击者连 `repo` 参数都不用给。
  if (task.repoCount <= 1) {
    if (task.worktreePath === '') {
      throw new NotFoundError(
        'task-worktree-not-ready',
        `task '${task.id}' has no worktree yet (repository preparation has not completed)`,
      )
    }
    return { worktreePath: task.worktreePath, baseCommit: task.baseCommit }
  }
  if (repoWire === undefined || repoWire === '') {
    throw new ValidationError(
      'file-symbols-repo-required',
      'repo query param required for a multi-repo task',
    )
  }
  const key = parseRepoKeyWire(repoWire)
  const keys = canonicalRepoKeys(task.repos)
  const idx = keys.indexOf(key)
  const repo = idx >= 0 ? task.repos[idx] : undefined
  if (repo === undefined) {
    throw new NotFoundError('file-symbols-repo-not-found', `repo '${repoWire}' not found`)
  }
  if (repo.worktreePath === '') {
    throw new NotFoundError(
      'task-worktree-not-ready',
      `task '${task.id}' repo '${repoWire}' has no worktree yet (preparation has not completed)`,
    )
  }
  return { worktreePath: repo.worktreePath, baseCommit: repo.baseCommit }
}

function toResult(
  lang: FileSymbolsResult['lang'],
  status: FileSymbolsResult['status'],
  symbols: readonly SymbolNode[] = [],
): FileSymbolsResult {
  return {
    lang,
    status,
    symbols: symbols.flatMap((s) =>
      s.range === undefined
        ? []
        : [
            {
              name: s.name,
              qualifiedName: s.qualifiedName,
              kind: s.kind,
              range: { startLine: s.range.startLine, endLine: s.range.endLine },
              ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
            },
          ],
    ),
  }
}

export async function getTaskFileSymbols(
  workspace: CodeWorkspaceRead,
  taskId: string,
  q: FileSymbolsQuery,
): Promise<FileSymbolsResult> {
  if (q.path === '') {
    throw new ValidationError('file-symbols-missing-path', 'path query param required')
  }
  const task = await workspace.findTask(taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const { worktreePath, baseCommit } = resolveRepoTarget(task, q.repo)

  let source: string
  if (q.side === 'base') {
    if (baseCommit === null || baseCommit === '') {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot read the base side`,
        409,
      )
    }
    const blob = await readBlobAtRef(worktreePath, baseCommit, q.path)
    if (blob === null) {
      throw new NotFoundError('file-symbols-not-found', `'${basename(q.path)}' not in base`)
    }
    if (blob.length > FILE_CONTENT_MAX_BYTES) {
      throw new DomainError('file-symbols-oversized', 'file exceeds the analyzable limit', 413)
    }
    if (blob.includes('\x00')) return toResult(null, 'unsupported')
    source = blob
  } else {
    const read = openContainedFile(worktreePath, q.path)
    switch (read.kind) {
      case 'ok':
        source = read.content
        break
      case 'not-found':
        throw new NotFoundError('file-symbols-not-found', `'${basename(q.path)}' not found`)
      case 'outside':
        throw new ValidationError(
          'file-symbols-path-escapes',
          `path '${basename(q.path)}' resolves outside the worktree`,
        )
      case 'oversized':
        throw new DomainError('file-symbols-oversized', 'file exceeds the analyzable limit', 413)
      case 'binary':
        return toResult(null, 'unsupported')
    }
  }

  const resolution = resolveLang(q.path)
  if (resolution === null) return toResult(null, 'unsupported')

  try {
    const { symbols, hadError } = await extractSymbols({
      lang: resolution.lang,
      grammarFile: resolution.grammarFile,
      filePath: q.path,
      source,
    })
    if (symbols.length === 0 && hadError) return toResult(resolution.lang, 'parse-error')
    return toResult(resolution.lang, hadError ? 'degraded' : 'ok', symbols)
  } catch {
    // fatal parse/grammar failure — a stable 200 state, not a 500 (F-09)
    return toResult(resolution.lang, 'parse-error')
  }
}
