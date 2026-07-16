// RFC-201 PR-A/T1 — route-local editable-scope state machine.
//
// The reducer is deliberately transport- and React-agnostic. Route owners own
// request execution and remote-read epochs; this module only decides which
// exact receipts/reads are causally allowed to change a draft.

import { stableStringify } from '@/lib/stable-stringify'

export type EditScopeValidity = 'valid' | 'invalid' | 'unknown'
export type EditScopeSubmitOutcome = 'definitive' | 'ambiguous'
export type EditScopeSemanticEqual<T> = (left: T, right: T) => boolean

export interface EditScopeSubmission<T> {
  requestId: string
  submittedRevision: number
  /** Immutable-by-contract snapshot captured when begin-submit is accepted. */
  submitted: T
}

export interface EditScopeSubmitError {
  requestId: string
  submittedRevision: number
  error: unknown
  outcome: EditScopeSubmitOutcome
}

export interface EditScopeState<T> {
  baseline: T
  draft: T
  /** Monotonic local-edit/discard generation; remote follow does not increment it. */
  revision: number
  dirty: boolean
  validity: EditScopeValidity
  inFlight?: EditScopeSubmission<T>
  /** Reads issued at or before this accepted-write floor cannot overwrite its receipt. */
  ignoreReadsThroughEpoch?: number
  lastAcceptedReadEpoch?: number
  ambiguousSubmit?: EditScopeSubmission<T>
  staleRemote?: T
  firstInvalidTarget?: string
  submitError?: EditScopeSubmitError
  /** Prevents a late receipt from matching a later retry that reused an id. */
  usedRequestIds: readonly string[]
}

export interface EditScopeReconciliation {
  requestId: string
  submittedRevision: number
}

export type EditScopeEvent<T> =
  | { type: 'edit'; draft: T }
  | { type: 'begin-submit'; requestId: string; submittedRevision: number }
  | {
      /**
       * Cancel an attempt that was prepared locally but whose transport was
       * never started. Request ids remain consumed so a late receipt can
       * never match a later attempt.
       */
      type: 'cancel-submit'
      requestId: string
      submittedRevision: number
    }
  | {
      type: 'submit-success'
      requestId: string
      submittedRevision: number
      persisted: T
      ignoreReadsThroughEpoch?: number
    }
  | {
      type: 'submit-error'
      requestId: string
      submittedRevision: number
      error: unknown
      outcome: EditScopeSubmitOutcome
    }
  | {
      type: 'remote-read'
      remote: T
      issuedEpoch: number
      /** Required when a read claims to resolve an ambiguous submission. */
      reconciliation?: EditScopeReconciliation
    }
  | { type: 'discard'; baseline?: T }
  | {
      type: 'validity'
      validity: Exclude<EditScopeValidity, 'unknown'>
      firstInvalidTarget?: string
    }

export interface CreateEditScopeOptions {
  validity?: EditScopeValidity
}

export function createEditScopeState<T>(
  baseline: T,
  options: CreateEditScopeOptions = {},
): EditScopeState<T> {
  return {
    baseline,
    draft: baseline,
    revision: 0,
    dirty: false,
    validity: options.validity ?? 'valid',
    usedRequestIds: [],
  }
}

export function defaultEditScopeSemanticEqual<T>(left: T, right: T): boolean {
  return stableStringify(left) === stableStringify(right)
}

/** React-compatible reducer; inject semantic equality for the owned projection. */
export function editScopeReducer<T>(
  state: EditScopeState<T>,
  event: EditScopeEvent<T>,
  semanticEqual: EditScopeSemanticEqual<T> = defaultEditScopeSemanticEqual,
): EditScopeState<T> {
  switch (event.type) {
    case 'edit': {
      const dirty = !semanticEqual(event.draft, state.baseline)
      return {
        ...state,
        draft: event.draft,
        revision: state.revision + 1,
        dirty,
        // A changed representation has not been checked until the child
        // reports its synchronous validation result.
        validity: 'unknown',
        firstInvalidTarget: undefined,
        submitError: state.ambiguousSubmit ? state.submitError : undefined,
      }
    }

    case 'validity':
      return {
        ...state,
        validity: event.validity,
        firstInvalidTarget: event.validity === 'invalid' ? event.firstInvalidTarget : undefined,
      }

    case 'begin-submit':
      return beginSubmit(state, event)

    case 'cancel-submit':
      return cancelSubmit(state, event)

    case 'submit-success':
      return settleSuccess(state, event, semanticEqual)

    case 'submit-error':
      return settleError(state, event)

    case 'remote-read':
      return acceptRemoteRead(state, event, semanticEqual)

    case 'discard':
      return discard(state, event)
  }
}

function cancelSubmit<T>(
  state: EditScopeState<T>,
  event: Extract<EditScopeEvent<T>, { type: 'cancel-submit' }>,
): EditScopeState<T> {
  if (!submissionMatches(state.inFlight, event)) return state
  return { ...state, inFlight: undefined }
}

function beginSubmit<T>(
  state: EditScopeState<T>,
  event: Extract<EditScopeEvent<T>, { type: 'begin-submit' }>,
): EditScopeState<T> {
  if (state.inFlight !== undefined) {
    throw new Error('edit scope already has an in-flight submission')
  }
  if (state.ambiguousSubmit !== undefined) {
    throw new Error('edit scope must reconcile its ambiguous submission before retrying')
  }
  if (!state.dirty || state.validity !== 'valid') {
    throw new Error('edit scope must be dirty and valid before submit')
  }
  if (event.submittedRevision !== state.revision) {
    throw new Error('edit scope submitted revision is not current')
  }
  if (event.requestId.length === 0 || state.usedRequestIds.includes(event.requestId)) {
    throw new Error('edit scope request id must be non-empty and unique')
  }

  return {
    ...state,
    inFlight: {
      requestId: event.requestId,
      submittedRevision: event.submittedRevision,
      submitted: state.draft,
    },
    usedRequestIds: [...state.usedRequestIds, event.requestId],
    submitError: undefined,
  }
}

function settleSuccess<T>(
  state: EditScopeState<T>,
  event: Extract<EditScopeEvent<T>, { type: 'submit-success' }>,
  semanticEqual: EditScopeSemanticEqual<T>,
): EditScopeState<T> {
  const attempt = state.inFlight
  if (!submissionMatches(attempt, event)) return state

  const caughtUp = state.revision === attempt.submittedRevision
  const draft = caughtUp ? event.persisted : state.draft
  return {
    ...state,
    baseline: event.persisted,
    draft,
    dirty: !semanticEqual(draft, event.persisted),
    inFlight: undefined,
    ambiguousSubmit: undefined,
    staleRemote: undefined,
    submitError: undefined,
    ignoreReadsThroughEpoch: maxDefined(
      state.ignoreReadsThroughEpoch,
      event.ignoreReadsThroughEpoch,
    ),
  }
}

function settleError<T>(
  state: EditScopeState<T>,
  event: Extract<EditScopeEvent<T>, { type: 'submit-error' }>,
): EditScopeState<T> {
  const attempt = state.inFlight
  if (!submissionMatches(attempt, event)) return state

  const submitError: EditScopeSubmitError = {
    requestId: event.requestId,
    submittedRevision: event.submittedRevision,
    error: event.error,
    outcome: event.outcome,
  }
  return {
    ...state,
    inFlight: undefined,
    ambiguousSubmit: event.outcome === 'ambiguous' ? attempt : undefined,
    submitError,
  }
}

function acceptRemoteRead<T>(
  state: EditScopeState<T>,
  event: Extract<EditScopeEvent<T>, { type: 'remote-read' }>,
  semanticEqual: EditScopeSemanticEqual<T>,
): EditScopeState<T> {
  if (
    (state.ignoreReadsThroughEpoch !== undefined &&
      event.issuedEpoch <= state.ignoreReadsThroughEpoch) ||
    (state.lastAcceptedReadEpoch !== undefined && event.issuedEpoch < state.lastAcceptedReadEpoch)
  ) {
    return state
  }

  const accepted = { ...state, lastAcceptedReadEpoch: event.issuedEpoch }
  const ambiguous = state.ambiguousSubmit
  if (ambiguous !== undefined) {
    const matchingReconcile = submissionMatches(ambiguous, event.reconciliation)
    if (matchingReconcile) {
      if (semanticEqual(event.remote, ambiguous.submitted)) {
        // The exact uncertain intent is now authoritative. A newer local
        // revision remains untouched and dirty against the advanced baseline.
        const caughtUp = state.revision === ambiguous.submittedRevision
        const draft = caughtUp ? event.remote : state.draft
        return {
          ...accepted,
          baseline: event.remote,
          draft,
          dirty: !semanticEqual(draft, event.remote),
          ambiguousSubmit: undefined,
          staleRemote: undefined,
          submitError: undefined,
        }
      }

      // A matching authoritative read that does not contain the submitted
      // intent proves this attempt is no longer outcome-unknown. Apply normal
      // dirty-remote rules below; the owner's fresh OCC token can now be used
      // for a genuinely new request id.
      return applyOrdinaryRemoteRead(
        {
          ...accepted,
          ambiguousSubmit: undefined,
          submitError: undefined,
        },
        event.remote,
        semanticEqual,
      )
    }

    // Ambient and mismatched reads may reveal a foreign remote, but may never
    // claim that the uncertain request succeeded merely because remote=draft.
    if (semanticEqual(event.remote, state.baseline)) return accepted
    if (semanticEqual(event.remote, state.draft)) return accepted
    return { ...accepted, staleRemote: event.remote }
  }

  return applyOrdinaryRemoteRead(accepted, event.remote, semanticEqual)
}

function applyOrdinaryRemoteRead<T>(
  state: EditScopeState<T>,
  remote: T,
  semanticEqual: EditScopeSemanticEqual<T>,
): EditScopeState<T> {
  if (!state.dirty) {
    return {
      ...state,
      baseline: remote,
      draft: remote,
      dirty: false,
      staleRemote: undefined,
    }
  }
  if (semanticEqual(remote, state.draft)) {
    return {
      ...state,
      baseline: remote,
      draft: remote,
      dirty: false,
      staleRemote: undefined,
    }
  }
  if (semanticEqual(remote, state.baseline)) {
    return state.staleRemote === undefined ? state : { ...state, staleRemote: undefined }
  }
  return { ...state, staleRemote: remote }
}

function discard<T>(
  state: EditScopeState<T>,
  event: Extract<EditScopeEvent<T>, { type: 'discard' }>,
): EditScopeState<T> {
  if (state.inFlight !== undefined) {
    throw new Error('edit scope cannot discard while a submission is in flight')
  }
  if (state.ambiguousSubmit !== undefined && event.baseline === undefined) {
    throw new Error('edit scope requires an authoritative baseline to discard outcome-unknown')
  }

  const baseline = event.baseline ?? state.baseline
  return {
    ...state,
    baseline,
    draft: baseline,
    revision: state.revision + 1,
    dirty: false,
    validity: 'valid',
    ambiguousSubmit: undefined,
    staleRemote: undefined,
    firstInvalidTarget: undefined,
    submitError: undefined,
  }
}

function submissionMatches<T>(
  submission: Pick<EditScopeSubmission<T>, 'requestId' | 'submittedRevision'> | undefined,
  candidate: { requestId: string; submittedRevision: number } | undefined,
): submission is EditScopeSubmission<T> {
  return (
    submission !== undefined &&
    candidate !== undefined &&
    submission.requestId === candidate.requestId &&
    submission.submittedRevision === candidate.submittedRevision
  )
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

export interface EditScopeStatusLike {
  dirty: boolean
  validity: EditScopeValidity
  inFlight?: unknown
  ambiguousSubmit?: unknown
  staleRemote?: unknown
  firstInvalidTarget?: string
}

export interface EditScopeAggregateState {
  dirty: boolean
  busy: boolean
  valid: boolean
  stale: boolean
  outcomeUnknown: boolean
  firstInvalidTarget?: string
}

export function aggregateEditScopeStates(
  scopes: Iterable<EditScopeStatusLike>,
): EditScopeAggregateState {
  let dirty = false
  let busy = false
  let valid = true
  let stale = false
  let outcomeUnknown = false
  let firstInvalidTarget: string | undefined

  for (const scope of scopes) {
    dirty ||= scope.dirty
    busy ||= scope.inFlight !== undefined
    stale ||= scope.staleRemote !== undefined
    outcomeUnknown ||= scope.ambiguousSubmit !== undefined
    if (scope.dirty && scope.validity !== 'valid') {
      valid = false
      if (firstInvalidTarget === undefined && scope.validity === 'invalid') {
        firstInvalidTarget = scope.firstInvalidTarget
      }
    }
  }

  return { dirty, busy, valid, stale, outcomeUnknown, firstInvalidTarget }
}

/**
 * Minimal child-to-route projection. It deliberately contains no draft data,
 * transport callback, or store reference: children only report edit state and
 * the route owner remains responsible for persistence.
 */
export interface EditScopeChildReport {
  dirty: boolean
  busy: boolean
  valid: boolean
  stale: boolean
  outcomeUnknown: boolean
  firstInvalidTarget?: string
}

export function createEditScopeChildReport(scope: EditScopeStatusLike): EditScopeChildReport {
  const valid = !scope.dirty || scope.validity === 'valid'
  return {
    dirty: scope.dirty,
    busy: scope.inFlight !== undefined,
    valid,
    stale: scope.staleRemote !== undefined,
    outcomeUnknown: scope.ambiguousSubmit !== undefined,
    firstInvalidTarget:
      scope.dirty && scope.validity === 'invalid' ? scope.firstInvalidTarget : undefined,
  }
}

export interface EditScopeRegistryEntry {
  scopeId: string
  /** Unique for one mounted/reporting child instance. */
  registrationId: string
  report: EditScopeChildReport
}

export interface EditScopeRegistryState {
  /** Stable route/resource identity. A change is the only automatic reset. */
  identity: string
  /** Fences reports queued by children belonging to an older identity. */
  generation: number
  scopes: ReadonlyMap<string, EditScopeRegistryEntry>
}

export type EditScopeRegistryEvent =
  | {
      type: 'register-scope'
      generation: number
      scopeId: string
      registrationId: string
      report: EditScopeChildReport
    }
  | {
      type: 'report-scope'
      generation: number
      scopeId: string
      registrationId: string
      report: EditScopeChildReport
    }
  | {
      type: 'unregister-scope'
      generation: number
      scopeId: string
      registrationId: string
    }
  | { type: 'reset-identity'; identity: string }

export function createEditScopeRegistryState(identity: string): EditScopeRegistryState {
  return { identity, generation: 0, scopes: new Map() }
}

/** React-compatible route-local registry reducer for heterogeneous children. */
export function editScopeRegistryReducer(
  state: EditScopeRegistryState,
  event: EditScopeRegistryEvent,
): EditScopeRegistryState {
  if (event.type === 'reset-identity') {
    if (event.identity === state.identity) return state
    return {
      identity: event.identity,
      generation: state.generation + 1,
      scopes: new Map(),
    }
  }

  if (event.generation !== state.generation) return state

  switch (event.type) {
    case 'register-scope': {
      assertEditScopeRegistration(event.scopeId, event.registrationId)
      const current = state.scopes.get(event.scopeId)
      if (
        current?.registrationId === event.registrationId &&
        editScopeChildReportsEqual(current.report, event.report)
      ) {
        return state
      }
      const scopes = new Map(state.scopes)
      scopes.set(event.scopeId, {
        scopeId: event.scopeId,
        registrationId: event.registrationId,
        report: copyEditScopeChildReport(event.report),
      })
      return { ...state, scopes }
    }

    case 'report-scope': {
      const current = state.scopes.get(event.scopeId)
      if (current?.registrationId !== event.registrationId) return state
      if (editScopeChildReportsEqual(current.report, event.report)) return state
      const scopes = new Map(state.scopes)
      scopes.set(event.scopeId, {
        ...current,
        report: copyEditScopeChildReport(event.report),
      })
      return { ...state, scopes }
    }

    case 'unregister-scope': {
      const current = state.scopes.get(event.scopeId)
      if (current?.registrationId !== event.registrationId) return state
      const scopes = new Map(state.scopes)
      scopes.delete(event.scopeId)
      return { ...state, scopes }
    }
  }
}

export function aggregateEditScopeRegistry(
  state: Pick<EditScopeRegistryState, 'scopes'>,
): EditScopeAggregateState {
  let dirty = false
  let busy = false
  let valid = true
  let stale = false
  let outcomeUnknown = false
  let firstInvalidTarget: string | undefined

  for (const { report } of state.scopes.values()) {
    dirty ||= report.dirty
    busy ||= report.busy
    stale ||= report.stale
    outcomeUnknown ||= report.outcomeUnknown
    if (report.dirty && !report.valid) {
      valid = false
      firstInvalidTarget ??= report.firstInvalidTarget
    }
  }

  return { dirty, busy, valid, stale, outcomeUnknown, firstInvalidTarget }
}

export interface CreateEditScopeChildAdapterOptions {
  scopeId: string
  /** Must be unique for every reporting instance within one generation. */
  registrationId: string
  generation: number
}

export interface EditScopeChildAdapter {
  register(
    report: EditScopeChildReport,
  ): Extract<EditScopeRegistryEvent, { type: 'register-scope' }>
  report(report: EditScopeChildReport): Extract<EditScopeRegistryEvent, { type: 'report-scope' }>
  unregister(): Extract<EditScopeRegistryEvent, { type: 'unregister-scope' }>
}

/**
 * Pure event adapter. The caller may feed its return values to useReducer;
 * there is intentionally no global registry or API side effect here.
 */
export function createEditScopeChildAdapter(
  options: CreateEditScopeChildAdapterOptions,
): EditScopeChildAdapter {
  assertEditScopeRegistration(options.scopeId, options.registrationId)
  const base = {
    generation: options.generation,
    scopeId: options.scopeId,
    registrationId: options.registrationId,
  }
  return {
    register: (report) => ({ type: 'register-scope', ...base, report }),
    report: (report) => ({ type: 'report-scope', ...base, report }),
    unregister: () => ({ type: 'unregister-scope', ...base }),
  }
}

function assertEditScopeRegistration(scopeId: string, registrationId: string): void {
  if (scopeId.length === 0 || registrationId.length === 0) {
    throw new Error('edit scope id and registration id must be non-empty')
  }
}

function copyEditScopeChildReport(report: EditScopeChildReport): EditScopeChildReport {
  return {
    dirty: report.dirty,
    busy: report.busy,
    valid: report.valid,
    stale: report.stale,
    outcomeUnknown: report.outcomeUnknown,
    firstInvalidTarget: report.firstInvalidTarget,
  }
}

function editScopeChildReportsEqual(
  left: EditScopeChildReport,
  right: EditScopeChildReport,
): boolean {
  return (
    left.dirty === right.dirty &&
    left.busy === right.busy &&
    left.valid === right.valid &&
    left.stale === right.stale &&
    left.outcomeUnknown === right.outcomeUnknown &&
    left.firstInvalidTarget === right.firstInvalidTarget
  )
}

export interface EditScopeNavigationLocation {
  pathname: string
  search?: Readonly<Record<string, unknown>>
  hash?: string
}

export interface SameResourceSectionChangeOptions<L extends EditScopeNavigationLocation> {
  /** Exact validated-search keys registered as section selectors by this route. */
  sectionKeys: readonly string[]
  resourceIdentity: (location: L) => string | null
}

/**
 * True only for a real section change on one exact resource. Path/hash and all
 * non-section search must remain equal; this is intentionally not a generic
 * "same pathname" query-string bypass.
 */
export function allowSameResourceSectionChange<L extends EditScopeNavigationLocation>(
  current: L,
  next: L,
  options: SameResourceSectionChangeOptions<L>,
): boolean {
  if (current.pathname !== next.pathname || (current.hash ?? '') !== (next.hash ?? '')) {
    return false
  }
  const currentIdentity = options.resourceIdentity(current)
  if (currentIdentity === null || currentIdentity !== options.resourceIdentity(next)) return false

  const allowed = new Set(options.sectionKeys)
  if (allowed.size === 0) return false
  const currentSearch = current.search ?? {}
  const nextSearch = next.search ?? {}
  const keys = new Set([...Object.keys(currentSearch), ...Object.keys(nextSearch)])
  let changedSection = false

  for (const key of keys) {
    const changed = stableStringify(currentSearch[key]) !== stableStringify(nextSearch[key])
    if (!changed) continue
    if (!allowed.has(key)) return false
    changedSection = true
  }
  return changedSection
}

export function shouldBlockEditScopeNavigation<L extends EditScopeNavigationLocation>(
  state: Pick<EditScopeAggregateState, 'dirty' | 'busy'>,
  current: L,
  next: L,
  options: SameResourceSectionChangeOptions<L>,
): boolean {
  // Mutating requests cannot offer a truthful discard-and-leave action.
  if (state.busy) return true
  if (!state.dirty) return false
  return !allowSameResourceSectionChange(current, next, options)
}
