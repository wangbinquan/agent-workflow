import type {
  ObservationCapturedUsage,
  ObservationPriorSpanRevision,
  ObservationSpanFact,
  ObservationSpanOwnerProof,
  ObservationSpanScope,
  ObservationSpanState,
} from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import type {
  NativeSpan,
  NativeSpanCapture,
  NativeSpanCaptureIdentity,
  NativeSpanOwnerLookup,
  NativeSpanRootBinding,
  NativeSpanSnapshot,
} from './ports/nativeSpanCapture'

const identity = (span: NativeSpan) => JSON.stringify([span.sessionId, span.kind, span.callId])
const material = (span: NativeSpan) =>
  JSON.stringify([
    span.parentSessionId,
    span.ancestors,
    span.label,
    span.parentCallId,
    span.model,
    span.measurementRecordId,
  ])
const closedStatus = (status: ObservationSpanState['status']) =>
  status === 'success' || status === 'error' || status === 'cancelled'
function mergeState(
  before: ObservationSpanState,
  after: ObservationSpanState,
): ObservationSpanState | null {
  if (before.startedAt !== null && after.startedAt !== null && before.startedAt !== after.startedAt)
    return null
  if (before.endedAt !== null && after.endedAt !== null && before.endedAt !== after.endedAt)
    return null
  if (closedStatus(before.status) && closedStatus(after.status) && before.status !== after.status)
    return null
  const startedAt = before.startedAt ?? after.startedAt,
    endedAt = before.endedAt ?? after.endedAt
  if (startedAt !== null && endedAt !== null && endedAt < startedAt) return null
  return {
    startedAt,
    endedAt,
    nativeObservedAt: after.nativeObservedAt ?? before.nativeObservedAt,
    status: closedStatus(before.status)
      ? before.status
      : closedStatus(after.status)
        ? after.status
        : before.status === 'open' || after.status === 'open'
          ? 'open'
          : 'unknown',
  }
}
interface Root {
  binding: NativeSpanRootBinding
  baseline?: NativeSpanSnapshot
  owners?: NativeSpanOwnerLookup
  lookup: Promise<void>
  pending: NativeSpan[]
  facts: Map<string, ObservationSpanFact>
  revisions: Map<string, ObservationPriorSpanRevision>
  savedRevisions: Map<string, ObservationPriorSpanRevision>
  baselineSpans: Map<string, NativeSpan>
  ownerByScope: Map<string, ObservationSpanOwnerProof[]>
  latest: Map<string, NativeSpan>
  issues: Set<string>
  eligible: boolean
}

/** All asynchronous work only prepares memory. The original runner owns every journal write. */
export function createNativeSpanCapture(
  input: NativeSpanCaptureIdentity & {
    readonly sourceNamespace: string
    readonly read?: (root: string) => NativeSpanSnapshot
    readonly requireNativeCreationTime?: boolean
    readonly streamOnly?: boolean
    readonly now?: () => number
    readonly budgetMs?: number
  },
): NativeSpanCapture {
  const roots = new Map<string, Root>(),
    now = input.now ?? Date.now
  const budget = Math.max(0, Math.min(400, Number.isFinite(input.budgetMs) ? input.budgetMs! : 400))
  let begun = false,
    closed = false,
    finished: ObservationCapturedUsage[] | undefined
  const rootKey = (id: string, epoch: number) => JSON.stringify([id, epoch])
  const scope = (span: NativeSpan, root: Root): ObservationSpanScope => ({
    sourceNamespace: input.sourceNamespace,
    rootSessionId: root.binding.rootSessionId,
    nativeSessionId: span.sessionId,
    parentNativeSessionId: span.parentSessionId,
    ancestors: [...span.ancestors],
    callId: span.callId,
    kind: span.kind,
  })
  const ownerEligible = (proof: ObservationSpanOwnerProof, root: Root) =>
    proof.accepted.taskId === input.accepted.taskId &&
    proof.accepted.authority.kind === 'local' &&
    proof.accepted.spanCaptureContract === 'runtime-span-facts-v1' &&
    proof.accepted.spanCaptureSource === input.sourceNamespace &&
    proof.scope.sourceNamespace === input.sourceNamespace &&
    proof.scope.rootSessionId === root.binding.rootSessionId
  const ordinaryConflict = (root: Root, key: string, code: string) => {
    root.issues.add(code)
    const original = root.latest.get(key)
    if (!original) return
    const issues = [...new Set([...(original.issues ?? []), code])].slice(0, 20)
    root.latest.set(key, { ...original, issues })
    const fact = root.facts.get(key)
    if (fact) root.facts.set(key, { ...fact, issues })
  }
  const recordRevision = (root: Root, key: string, revision: ObservationPriorSpanRevision) => {
    const previous = root.savedRevisions.get(key)
    const after = previous ? mergeState(previous.after, revision.after) : revision.after
    if (
      !after ||
      (previous &&
        JSON.stringify(previous.originalOwnerProof) !== JSON.stringify(revision.originalOwnerProof))
    ) {
      root.issues.add('native-prior-span-state-conflict')
      if (
        previous &&
        JSON.stringify(previous.originalOwnerProof) === JSON.stringify(revision.originalOwnerProof)
      ) {
        // Retain both actual native observations so the original owner's projection becomes unknown.
        const conflictKey = `${key}:${sha256Hex(JSON.stringify(revision.after))}`
        if (!root.savedRevisions.has(conflictKey) && root.savedRevisions.size >= 5000) {
          root.issues.add('native-span-budget')
          return
        }
        root.revisions.set(conflictKey, revision)
        root.savedRevisions.set(conflictKey, revision)
      }
      return
    }
    if (!root.savedRevisions.has(key) && root.savedRevisions.size >= 5000) {
      root.issues.add('native-span-budget')
      return
    }
    const value = { ...revision, after }
    root.revisions.set(key, value)
    root.savedRevisions.set(key, value)
  }
  const attribute = (root: Root, span: NativeSpan, capturedAt: number) => {
    if (!root.eligible || !root.binding.originalRootAccepted) return
    // OpenCode's native final message supplies the actual model, independently of live numbers.
    if (!input.streamOnly && span.kind === 'model' && span.origin === 'creation') return
    const key = identity(span),
      currentScope = scope(span, root)
    const prior = root.baselineSpans.get(key)
    const owners = root.ownerByScope.get(JSON.stringify(currentScope)) ?? []
    if (input.streamOnly && span.origin === 'completion') {
      const current = root.latest.get(key)
      if (current) {
        const state = mergeState(current.state, span.state)
        if (!state) {
          ordinaryConflict(root, key, 'native-span-state-conflict')
          return
        }
        attribute(root, { ...current, state, origin: 'creation' }, capturedAt)
      } else if (
        owners.length === 1 &&
        owners[0]!.accepted.invocationId !== input.accepted.invocationId
      ) {
        const proof = owners[0]!,
          before = proof.creation.state,
          after = mergeState(before, span.state)
        if (!after) root.issues.add('native-prior-span-state-conflict')
        recordRevision(root, key, {
          carrierInvocationId: input.accepted.invocationId,
          targetOwnerInvocationId: proof.accepted.invocationId,
          targetSpanKey: proof.spanKey,
          originalOwnerProof: proof,
          before,
          after: after ?? span.state,
          capturedAt,
        })
      } else root.issues.add('native-span-result-unpaired')
      return
    }
    if (prior) {
      if (owners.length !== 1 || owners[0]!.accepted.invocationId === input.accepted.invocationId) {
        root.issues.add('native-prior-span-owner-unavailable')
        return
      }
      if (material(prior) !== material(span)) {
        root.issues.add('native-prior-span-scope-conflict')
        return
      }
      const after = mergeState(prior.state, span.state)
      if (!after) root.issues.add('native-prior-span-state-conflict')
      if (JSON.stringify(after) === JSON.stringify(prior.state)) return
      const proof = owners[0]!
      recordRevision(root, key, {
        carrierInvocationId: input.accepted.invocationId,
        targetOwnerInvocationId: proof.accepted.invocationId,
        targetSpanKey: proof.spanKey,
        originalOwnerProof: proof,
        before: prior.state,
        after: after ?? span.state,
        capturedAt,
      })
      return
    }
    // Historical owners cannot become new ordinary creations on a resume/reset.
    if (owners.some((proof) => proof.accepted.invocationId !== input.accepted.invocationId)) {
      root.issues.add('native-prior-span-baseline-gap')
      return
    }
    const previous = root.latest.get(key)
    if (previous && material(previous) !== material(span)) {
      ordinaryConflict(root, key, 'native-span-material-conflict')
      return
    }
    const state = previous ? mergeState(previous.state, span.state) : span.state
    if (!state) {
      ordinaryConflict(root, key, 'native-span-state-conflict')
      return
    }
    const spanIssues = [...new Set([...(previous?.issues ?? []), ...(span.issues ?? [])])].slice(
      0,
      20,
    )
    root.latest.set(key, { ...span, state, ...(spanIssues.length ? { issues: spanIssues } : {}) })
    if (root.latest.size > 5000) {
      root.latest.delete(key)
      root.issues.add('native-span-budget')
      return
    }
    root.facts.set(key, {
      schemaVersion: 1,
      invocationId: input.accepted.invocationId,
      spanKey: sha256Hex(JSON.stringify([input.accepted.invocationId, currentScope])),
      scope: currentScope,
      label: span.label,
      parentCallId: span.parentCallId,
      model: span.model,
      measurementRecordId: span.measurementRecordId,
      state,
      capturedAt,
      ...(spanIssues.length ? { issues: spanIssues } : {}),
    })
  }
  const settleLookup = async (root: Root) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const owners = await Promise.race([
        input.lookupOwners({
          sourceNamespace: input.sourceNamespace,
          rootSessionId: root.binding.rootSessionId,
          limit: 5000,
        }),
        new Promise<NativeSpanOwnerLookup>((resolve) => {
          timer = setTimeout(
            () => resolve({ owners: [], complete: false, issues: ['native-span-owner-budget'] }),
            budget,
          )
        }),
      ])
      if (closed) return
      root.owners = owners
      if (owners.owners.length > 5000) {
        root.issues.add('native-span-owner-budget')
        return
      }
      for (const proof of owners.owners)
        if (ownerEligible(proof, root)) {
          const key = JSON.stringify(proof.scope)
          root.ownerByScope.set(key, [...(root.ownerByScope.get(key) ?? []), proof])
        }
      for (const issue of owners.issues) root.issues.add(issue)
      if (!owners.complete) {
        root.issues.add('native-span-owner-unavailable')
        return
      }
      if (root.binding.mode === 'resume') {
        root.eligible = input.streamOnly === true || root.baseline?.fingerprint != null
        if (!root.eligible) root.issues.add('native-span-baseline-unavailable')
      } else {
        const snapshot = input.requireNativeCreationTime
          ? input.read?.(root.binding.rootSessionId)
          : undefined
        const fresh =
          !input.requireNativeCreationTime ||
          (snapshot?.clockQuality === 'same-host-native' &&
            !snapshot.issues.includes('native-span-root-parent-conflict') &&
            snapshot.rootCreatedAt !== null &&
            root.binding.spawnedAt !== null &&
            snapshot.rootCreatedAt >= root.binding.spawnedAt)
        root.eligible = fresh && !owners.owners.some((proof) => ownerEligible(proof, root))
        if (!root.eligible) root.issues.add('native-span-fresh-root-unproven')
      }
    } catch {
      if (!closed) root.issues.add('native-span-owner-unavailable')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const createRoot = (binding: NativeSpanRootBinding): Root => {
    const root: Root = {
      binding,
      lookup: Promise.resolve(),
      pending: [],
      facts: new Map(),
      revisions: new Map(),
      savedRevisions: new Map(),
      baselineSpans: new Map(),
      ownerByScope: new Map(),
      latest: new Map(),
      issues: new Set(),
      eligible: false,
    }
    if (binding.mode === 'resume') {
      try {
        root.baseline = input.read?.(binding.rootSessionId)
      } catch {
        root.issues.add('native-span-baseline-unavailable')
      }
      for (const issue of root.baseline?.issues ?? []) root.issues.add(issue)
      for (const span of root.baseline?.spans ?? []) root.baselineSpans.set(identity(span), span)
    }
    roots.set(rootKey(binding.rootSessionId, binding.epoch), root)
    root.lookup = settleLookup(root)
    return root
  }
  const drain = (root: Root, capturedAt: number) => {
    if (!root.owners || !root.binding.originalRootAccepted) return
    for (const span of root.pending) attribute(root, span, capturedAt)
    root.pending.length = 0
  }
  const flush = (capturedAt: number): ObservationCapturedUsage[] => {
    const frames: ObservationCapturedUsage[] = []
    for (const root of roots.values()) {
      drain(root, capturedAt)
      const facts = [...root.facts.values()],
        revisions = [...root.revisions.values()]
      root.facts.clear()
      root.revisions.clear()
      const records = [
        ...facts.map((fact) => ({ fact })),
        ...revisions.map((revision) => ({ revision })),
      ]
      for (let start = 0; start < records.length; start += 200) {
        const chunk = records.slice(start, start + 200)
        frames.push({
          invocationId: input.accepted.invocationId,
          measurements: [],
          diagnostics: [],
          spanFacts: chunk.flatMap((item) => ('fact' in item ? [item.fact!] : [])),
          priorSpanRevisions: chunk.flatMap((item) => ('revision' in item ? [item.revision!] : [])),
        })
      }
    }
    return frames
  }
  return {
    contract: 'runtime-span-facts-v1',
    sourceNamespace: input.sourceNamespace,
    async begin() {
      if (begun) return
      begun = true
      if (input.resumeSessionId) {
        const root = createRoot({
          rootSessionId: input.resumeSessionId,
          epoch: 0,
          mode: 'resume',
          sourceNamespace: input.sourceNamespace,
          originalRootAccepted: false,
          spawnedAt: null,
        })
        await root.lookup
      }
    },
    bindRoot(binding) {
      if (closed || !begun || binding.sourceNamespace !== input.sourceNamespace) return
      const key = rootKey(binding.rootSessionId, binding.epoch),
        existing = roots.get(key)
      if (existing) {
        if (existing.binding.mode !== binding.mode) {
          existing.issues.add('native-span-root-conflict')
          return
        }
        existing.binding = binding
      } else createRoot(binding)
    },
    observe(span, rootSessionId, epoch) {
      if (closed) return
      const root = roots.get(rootKey(rootSessionId, epoch))
      if (!root) return
      if (root.owners && root.binding.originalRootAccepted) {
        const capturedAt = now()
        drain(root, capturedAt)
        attribute(root, span, capturedAt)
        return
      }
      // Ownership may resolve after multiple actual completions. Retain each distinct
      // native observation so contradiction checks see the original evidence too.
      const key = JSON.stringify([
        identity(span),
        material(span),
        span.origin,
        span.state,
        span.issues ?? [],
      ])
      if (
        root.pending.some(
          (buffered) =>
            JSON.stringify([
              identity(buffered),
              material(buffered),
              buffered.origin,
              buffered.state,
              buffered.issues ?? [],
            ]) === key,
        )
      )
        return
      if (root.pending.length >= 200) {
        root.issues.add('native-span-pending-budget')
        return
      }
      root.pending.push(span)
    },
    flush,
    async finish(bindings, capturedAt, processIssues = []) {
      if (finished) return finished
      if (closed) return []
      try {
        for (const binding of bindings) this.bindRoot(binding)
        await Promise.all([...roots.values()].map((root) => root.lookup))
        const summaries: ObservationCapturedUsage[] = []
        for (const root of roots.values()) {
          drain(root, capturedAt)
          for (const [key, revision] of root.savedRevisions) root.revisions.set(key, revision)
          for (const span of root.latest.values()) attribute(root, span, capturedAt)
          let snapshot: NativeSpanSnapshot | undefined
          try {
            snapshot = input.read?.(root.binding.rootSessionId)
          } catch {
            root.issues.add('native-span-source-unavailable')
          }
          if (snapshot) {
            for (const issue of snapshot.issues) root.issues.add(issue)
            for (const span of snapshot.spans) attribute(root, span, capturedAt)
          }
          for (const issue of processIssues) root.issues.add(issue)
          if (!root.binding.originalRootAccepted || !root.eligible)
            root.issues.add('native-span-root-unattributed')
          if (snapshot?.fingerprint == null)
            root.issues.add('native-span-final-snapshot-unavailable')
          const issues = [...root.issues].slice(0, 100)
          summaries.push({
            invocationId: input.accepted.invocationId,
            measurements: [],
            diagnostics: [],
            spanCapture: {
              contract: 'runtime-span-facts-v1',
              sourceNamespace: input.sourceNamespace,
              rootSessionId: root.binding.rootSessionId,
              epoch: root.binding.epoch,
              state: issues.length ? 'partial' : 'complete',
              baseline: {
                kind: root.binding.mode === 'resume' ? 'resume' : 'fresh',
                fingerprint: root.baseline?.fingerprint ?? null,
              },
              snapshotFingerprint: snapshot?.fingerprint ?? null,
              capturedAt,
              scannedSessions: snapshot?.scannedSessions ?? 0,
              scannedParts: snapshot?.scannedParts ?? 0,
              issues,
            },
          })
        }
        finished = [...flush(capturedAt), ...summaries]
        if (roots.size === 0)
          finished.push({
            invocationId: input.accepted.invocationId,
            measurements: [],
            diagnostics: ['native-span-root-unavailable'],
          })
        return finished
      } finally {
        closed = true
      }
    },
  }
}
