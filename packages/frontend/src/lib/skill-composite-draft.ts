// RFC-201 T3.2 — route-owned Skill composite draft helpers.
//
// Metadata/body and every staged file intent are independent edit scopes, but
// they share one OCC token and one Save All pipeline.  This module deliberately
// owns no React state and performs no writes; the Skill route remains the only
// persistence owner.

import type { FileNode, SkillContent } from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import {
  aggregateEditScopeStates,
  createEditScopeState,
  editScopeReducer,
  type EditScopeAggregateState,
  type EditScopeEvent,
  type EditScopeState,
} from '@/lib/edit-scope'

export interface SkillMetadataDraft {
  description: string
  bodyMd: string
}

export interface SkillFileDraft {
  exists: boolean
  content: string
}

export interface SkillCompositeDraftState {
  metadata: EditScopeState<SkillMetadataDraft>
  files: Readonly<Record<string, EditScopeState<SkillFileDraft>>>
  /** A typed-but-not-staged path is unsaved command state and blocks Save All. */
  newPath: EditScopeState<string>
}

export type SkillCompositeScopeTarget = { kind: 'metadata' } | { kind: 'file'; path: string }

export type SkillSaveStep =
  | {
      kind: 'metadata'
      scope: SkillCompositeScopeTarget
      submittedRevision: number
      submitted: SkillMetadataDraft
    }
  | {
      kind: 'file'
      scope: SkillCompositeScopeTarget
      path: string
      op: 'put' | 'delete'
      submittedRevision: number
      submitted: SkillFileDraft
    }

export const ABSENT_SKILL_FILE: SkillFileDraft = { exists: false, content: '' }

export function skillMetadataEqual(left: SkillMetadataDraft, right: SkillMetadataDraft): boolean {
  return left.description === right.description && left.bodyMd === right.bodyMd
}

export function skillFileEqual(left: SkillFileDraft, right: SkillFileDraft): boolean {
  return left.exists === right.exists && (!left.exists || left.content === right.content)
}

export function createSkillCompositeDraft(content: SkillContent): SkillCompositeDraftState {
  return {
    metadata: createEditScopeState({
      description: content.description,
      bodyMd: content.bodyMd,
    }),
    files: {},
    newPath: createEditScopeState(''),
  }
}

export function editSkillMetadata(
  state: SkillCompositeDraftState,
  draft: SkillMetadataDraft,
): SkillCompositeDraftState {
  let metadata = editScopeReducer(state.metadata, { type: 'edit', draft }, skillMetadataEqual)
  metadata = editScopeReducer(metadata, { type: 'validity', validity: 'valid' }, skillMetadataEqual)
  return { ...state, metadata }
}

/**
 * Publish one causally-tagged authoritative metadata/body read into the
 * route-owned composite. Clean scopes follow it; dirty scopes keep their local
 * draft and let the shared edit-scope reducer expose a foreign remote as stale.
 */
export function receiveSkillMetadata(
  state: SkillCompositeDraftState,
  remote: SkillMetadataDraft,
  issuedEpoch: number,
  reconciliation?: { requestId: string; submittedRevision: number },
): SkillCompositeDraftState {
  return reduceSkillCompositeScope(
    state,
    { kind: 'metadata' },
    {
      type: 'remote-read',
      remote,
      issuedEpoch,
      ...(reconciliation === undefined ? {} : { reconciliation }),
    },
  )
}

/**
 * `newPath` is a command draft, not a file operation.  Any non-empty value is
 * intentionally invalid for Save All until Add stages it or the user clears it.
 */
export function editSkillNewPath(
  state: SkillCompositeDraftState,
  value: string,
): SkillCompositeDraftState {
  let newPath = editScopeReducer(state.newPath, { type: 'edit', draft: value })
  newPath = editScopeReducer(newPath, {
    type: 'validity',
    validity: value.trim() === '' ? 'valid' : 'invalid',
    ...(value.trim() === '' ? {} : { firstInvalidTarget: 'skill-new-path' }),
  })
  return { ...state, newPath }
}

export function receiveSkillFile(
  state: SkillCompositeDraftState,
  path: string,
  content: string,
  issuedEpoch: number,
): SkillCompositeDraftState {
  const remote: SkillFileDraft = { exists: true, content }
  const current = state.files[path]
  const next =
    current === undefined
      ? createEditScopeState(remote)
      : editScopeReducer(current, { type: 'remote-read', remote, issuedEpoch }, skillFileEqual)
  return { ...state, files: { ...state.files, [path]: next } }
}

export function editSkillFile(
  state: SkillCompositeDraftState,
  path: string,
  content: string,
): SkillCompositeDraftState {
  const current = state.files[path]
  if (current === undefined || !current.draft.exists) {
    throw new Error(`skill file '${path}' is not loaded for editing`)
  }
  let next = editScopeReducer(
    current,
    { type: 'edit', draft: { exists: true, content } },
    skillFileEqual,
  )
  next = editScopeReducer(next, { type: 'validity', validity: 'valid' }, skillFileEqual)
  return { ...state, files: { ...state.files, [path]: next } }
}

export function stageSkillFileCreate(
  state: SkillCompositeDraftState,
  rawPath: string,
): SkillCompositeDraftState {
  const path = rawPath.trim()
  const current = state.files[path]
  if (path === '') throw new Error('skill file path is required')
  if (current !== undefined && current.draft.exists) {
    throw new Error(`skill file '${path}' already exists or is already staged`)
  }

  let scope = current ?? createEditScopeState(ABSENT_SKILL_FILE)
  scope = editScopeReducer(
    scope,
    { type: 'edit', draft: { exists: true, content: '' } },
    skillFileEqual,
  )
  scope = editScopeReducer(scope, { type: 'validity', validity: 'valid' }, skillFileEqual)
  return {
    ...state,
    files: { ...state.files, [path]: scope },
    newPath: createEditScopeState(''),
  }
}

export function stageSkillFileDelete(
  state: SkillCompositeDraftState,
  path: string,
): SkillCompositeDraftState {
  const current = state.files[path]
  if (current === undefined) throw new Error(`skill file '${path}' is not loaded for deletion`)
  if (current.inFlight !== undefined || current.ambiguousSubmit !== undefined) return state

  // Deleting a not-yet-persisted create simply cancels that staged operation.
  if (!current.baseline.exists) {
    const { [path]: _removed, ...files } = state.files
    return { ...state, files }
  }

  let next = editScopeReducer(current, { type: 'edit', draft: ABSENT_SKILL_FILE }, skillFileEqual)
  next = editScopeReducer(next, { type: 'validity', validity: 'valid' }, skillFileEqual)
  return { ...state, files: { ...state.files, [path]: next } }
}

export function undoSkillFile(
  state: SkillCompositeDraftState,
  path: string,
): SkillCompositeDraftState {
  const current = state.files[path]
  if (
    current === undefined ||
    current.inFlight !== undefined ||
    current.ambiguousSubmit !== undefined
  ) {
    return state
  }
  if (!current.baseline.exists) {
    const { [path]: _removed, ...files } = state.files
    return { ...state, files }
  }
  return {
    ...state,
    files: {
      ...state.files,
      [path]: editScopeReducer(current, { type: 'discard' }, skillFileEqual),
    },
  }
}

export function getSkillCompositeScope(
  state: SkillCompositeDraftState,
  target: SkillCompositeScopeTarget,
): EditScopeState<SkillMetadataDraft> | EditScopeState<SkillFileDraft> | undefined {
  return target.kind === 'metadata' ? state.metadata : state.files[target.path]
}

export function reduceSkillCompositeScope(
  state: SkillCompositeDraftState,
  target: { kind: 'metadata' },
  event: EditScopeEvent<SkillMetadataDraft>,
): SkillCompositeDraftState
export function reduceSkillCompositeScope(
  state: SkillCompositeDraftState,
  target: { kind: 'file'; path: string },
  event: EditScopeEvent<SkillFileDraft>,
): SkillCompositeDraftState
export function reduceSkillCompositeScope(
  state: SkillCompositeDraftState,
  target: SkillCompositeScopeTarget,
  event: EditScopeEvent<SkillMetadataDraft> | EditScopeEvent<SkillFileDraft>,
): SkillCompositeDraftState {
  if (target.kind === 'metadata') {
    return {
      ...state,
      metadata: editScopeReducer(
        state.metadata,
        event as EditScopeEvent<SkillMetadataDraft>,
        skillMetadataEqual,
      ),
    }
  }
  const current = state.files[target.path]
  if (current === undefined) return state
  return {
    ...state,
    files: {
      ...state.files,
      [target.path]: editScopeReducer(
        current,
        event as EditScopeEvent<SkillFileDraft>,
        skillFileEqual,
      ),
    },
  }
}

export function aggregateSkillCompositeDraft(
  state: SkillCompositeDraftState,
): EditScopeAggregateState {
  return aggregateEditScopeStates([state.metadata, state.newPath, ...Object.values(state.files)])
}

export function discardSkillCompositeDraft(
  state: SkillCompositeDraftState,
): SkillCompositeDraftState {
  const aggregate = aggregateSkillCompositeDraft(state)
  if (aggregate.busy || aggregate.outcomeUnknown) return state

  const metadata = editScopeReducer(
    state.metadata,
    {
      type: 'discard',
      ...(state.metadata.staleRemote === undefined ? {} : { baseline: state.metadata.staleRemote }),
    },
    skillMetadataEqual,
  )
  const files: Record<string, EditScopeState<SkillFileDraft>> = {}
  for (const [path, scope] of Object.entries(state.files)) {
    if (!scope.baseline.exists && scope.staleRemote === undefined) continue
    const discarded = editScopeReducer(
      scope,
      {
        type: 'discard',
        ...(scope.staleRemote === undefined ? {} : { baseline: scope.staleRemote }),
      },
      skillFileEqual,
    )
    if (discarded.baseline.exists) files[path] = discarded
  }
  return {
    metadata,
    files,
    newPath: createEditScopeState(''),
  }
}

/** Capture a semantic/revision plan once; callers must not reread drafts mid-pipeline. */
export function captureSkillSavePlan(state: SkillCompositeDraftState): readonly SkillSaveStep[] {
  const aggregate = aggregateSkillCompositeDraft(state)
  if (!aggregate.valid || aggregate.busy || aggregate.outcomeUnknown) return []

  const steps: SkillSaveStep[] = []
  if (state.metadata.dirty) {
    steps.push({
      kind: 'metadata',
      scope: { kind: 'metadata' },
      submittedRevision: state.metadata.revision,
      submitted: { ...state.metadata.draft },
    })
  }

  const fileSteps = Object.entries(state.files)
    .filter(([, scope]) => scope.dirty)
    .map(
      ([path, scope]): SkillSaveStep => ({
        kind: 'file',
        scope: { kind: 'file', path },
        path,
        op: scope.draft.exists ? 'put' : 'delete',
        submittedRevision: scope.revision,
        submitted: { ...scope.draft },
      }),
    )
    .sort((left, right) => {
      if (left.kind !== 'file' || right.kind !== 'file') return 0
      return `${left.path}\0${left.op}`.localeCompare(`${right.path}\0${right.op}`)
    })
  steps.push(...fileSteps)
  return steps
}

/** 4xx proves rejection. Network loss, malformed success, and 5xx stay ambiguous. */
export function isDefinitiveSkillWriteError(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
}

export interface StableSkillSnapshotReader {
  readContent: () => Promise<SkillContent>
  readTree: () => Promise<readonly FileNode[]>
  readFile: (path: string) => Promise<{ content: string }>
}

export interface StableSkillSnapshot {
  kind: 'stable'
  token: string
  metadata: SkillMetadataDraft
  tree: readonly FileNode[]
  files: Readonly<Record<string, SkillFileDraft>>
  attempts: number
}

export interface UnstableSkillSnapshot {
  kind: 'unstable'
  tokenBefore?: string
  tokenAfter?: string
  attempts: number
}

export type SkillSnapshotResult = StableSkillSnapshot | UnstableSkillSnapshot

/**
 * Read one non-torn authoritative snapshot.  A token movement retries the whole
 * sequence (never just the tail); after two automatic retries the caller keeps
 * outcome-unknown and offers an explicit recheck.
 */
export async function readStableSkillSnapshot(
  reader: StableSkillSnapshotReader,
  affectedPaths: readonly string[],
  maxTokenChangeRetries = 2,
): Promise<SkillSnapshotResult> {
  const paths = [...new Set(affectedPaths)].sort()
  let lastBefore: string | undefined
  let lastAfter: string | undefined

  for (let attempt = 1; attempt <= maxTokenChangeRetries + 1; attempt += 1) {
    const before = await reader.readContent()
    const metadata = await reader.readContent()
    const tree = await reader.readTree()
    const files: Record<string, SkillFileDraft> = {}
    for (const path of paths) {
      try {
        const file = await reader.readFile(path)
        files[path] = { exists: true, content: file.content }
      } catch (error) {
        if (isNotFound(error)) files[path] = ABSENT_SKILL_FILE
        else throw error
      }
    }
    const after = await reader.readContent()
    lastBefore = before.token
    lastAfter = after.token

    const stableToken = before.token
    if (
      stableToken === undefined ||
      stableToken !== metadata.token ||
      stableToken !== after.token
    ) {
      continue
    }

    // Token stability must also describe one coherent tree/content view.
    for (const path of paths) {
      const treeHasFile = tree.some((node) => node.path === path && node.type === 'file')
      if (treeHasFile !== files[path]!.exists) {
        throw new Error(`skill stable snapshot disagrees about file '${path}'`)
      }
    }

    return {
      kind: 'stable',
      token: stableToken,
      metadata: { description: metadata.description, bodyMd: metadata.bodyMd },
      tree,
      files,
      attempts: attempt,
    }
  }

  return {
    kind: 'unstable',
    ...(lastBefore === undefined ? {} : { tokenBefore: lastBefore }),
    ...(lastAfter === undefined ? {} : { tokenAfter: lastAfter }),
    attempts: maxTokenChangeRetries + 1,
  }
}

function isNotFound(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 404) ||
    (typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: unknown }).status === 404)
  )
}
