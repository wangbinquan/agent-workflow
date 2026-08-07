// RFC-270 AC-16 — author 门的 403 不再等于「这个工作流没了」。
//
// 用户看到的「权限异常」就是这条链的末端：
//   `scriptAuthorGate.ts` 抛 403（`script-author-forbidden`）
//   → `failureFromError` 把 `ApiError.code` 整个丢掉
//   → `saveFailed` 把 `403 || 404` 一律判成**终态** `inaccessible`
//   → 弹「无法继续访问此工作流 / 此工作流可能已删除或权限已变化」，并给出四个
//      全都无效的出口（重试访问永远再 403；另存为副本走 `insertWorkflowInTx`，
//      那条路根本没有 `previous`，必 403）。
//
// 所以这里既锁正例，也**必须**锁反例——不带 code 的 403 仍然是 `inaccessible`。
// 少了反例，把判据放宽成「所有 403 都不算丢访问」也能让正例全绿，而那会把真正的
// 权限撤销伪装成一次普通保存失败，让用户对着一份再也存不进去的草稿一直点重试。

import { describe, expect, test } from 'vitest'
import type {
  WorkflowDraftSnapshot,
  WorkflowMutationId,
  WorkflowRevision,
  WorkflowSnapshotHash,
} from '@agent-workflow/shared'
import {
  AUTHOR_FORBIDDEN_CODES,
  createWorkflowEditorDraftState,
  isAuthorForbiddenFailure,
  transitionWorkflowEditorDraft,
  type WorkflowDraftFailure,
  type WorkflowEditorDraftState,
  type WorkflowRemoteSnapshot,
} from '@/lib/workflow-editor-draft'

const MUTATION = '01KXF000000000000000000001' as WorkflowMutationId

function hash(char: string): WorkflowSnapshotHash {
  return char.repeat(64) as WorkflowSnapshotHash
}

function snapshot(description = 'base'): WorkflowDraftSnapshot {
  return {
    name: 'workflow',
    description,
    definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
  }
}

function revision(version: number, snapshotHash: WorkflowSnapshotHash): WorkflowRevision {
  return { workflowId: 'wf-1', version, snapshotHash, updatedAt: version * 100 }
}

function remote(): WorkflowRemoteSnapshot {
  return { revision: revision(1, hash('a')), snapshot: snapshot() }
}

function failure(status: number, code?: string): WorkflowDraftFailure {
  return { kind: 'http', status, message: 'nope', ...(code === undefined ? {} : { code }) }
}

/** 走到「有一发保存在飞」的状态，然后让它以给定 failure 失败。 */
function failSave(f: WorkflowDraftFailure): WorkflowEditorDraftState {
  const dirty = transitionWorkflowEditorDraft(createWorkflowEditorDraftState(remote()), {
    type: 'LOCAL_COMMIT',
    snapshot: snapshot('edited'),
  }).state
  const started = transitionWorkflowEditorDraft(dirty, {
    type: 'SAVE_REQUESTED',
    revision: dirty.revision,
    clientMutationId: MUTATION,
    snapshot: dirty.local,
    snapshotHash: hash('b'),
  }).state
  return transitionWorkflowEditorDraft(started, {
    type: 'SAVE_FAILED',
    clientMutationId: MUTATION,
    failure: f,
  }).state
}

describe('RFC-270 · isAuthorForbiddenFailure', () => {
  test('两个 author 码在 403 上为真', () => {
    for (const code of AUTHOR_FORBIDDEN_CODES) {
      expect(isAuthorForbiddenFailure(failure(403, code))).toBe(true)
    }
  })

  test('不带 code 的 403 为假（真正的访问丢失）', () => {
    expect(isAuthorForbiddenFailure(failure(403))).toBe(false)
  })

  test('别的 403 码为假（不许放宽成「所有 403」）', () => {
    expect(isAuthorForbiddenFailure(failure(403, 'forbidden'))).toBe(false)
  })

  test('同一个码配别的状态码为假', () => {
    expect(isAuthorForbiddenFailure(failure(404, 'script-author-forbidden'))).toBe(false)
  })

  test('null 为假', () => {
    expect(isAuthorForbiddenFailure(null)).toBe(false)
  })

  test('码表就是两条，且与后端错误码逐字一致', () => {
    expect([...AUTHOR_FORBIDDEN_CODES].sort()).toEqual([
      'code-host-author-forbidden',
      'script-author-forbidden',
    ])
  })
})

describe('RFC-270 AC-16 · SAVE_FAILED 分流', () => {
  test('script-author-forbidden → 非终态 error，草稿保留，code 传下去了', () => {
    const state = failSave(failure(403, 'script-author-forbidden'))
    expect(state.phase).toBe('error')
    expect(state.phase).not.toBe('inaccessible')
    expect(state.error?.code).toBe('script-author-forbidden')
    // 本地草稿必须还在 —— 用户撤销一步就能继续存。
    expect(state.local.description).toBe('edited')
  })

  test('code-host-author-forbidden 同样走非终态 error', () => {
    expect(failSave(failure(403, 'code-host-author-forbidden')).phase).toBe('error')
  })

  test('反例：不带 code 的 403 仍然是终态 inaccessible（真访问丢失）', () => {
    expect(failSave(failure(403)).phase).toBe('inaccessible')
  })

  test('反例：404 仍然是终态 inaccessible', () => {
    expect(failSave(failure(404)).phase).toBe('inaccessible')
  })

  test('error 相位不排重试定时器 —— 否则就是 403 死循环', () => {
    const state = failSave(failure(403, 'script-author-forbidden'))
    expect(state.reconcileRetry.nextAt).toBeNull()
    expect(state.inFlight).toBeNull()
  })
})
