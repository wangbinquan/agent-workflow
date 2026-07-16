// RFC-201 PR-A/T1 — regression locks for the route-local edit-scope state
// machine. These cases prevent late writes/reads, response-loss recovery, and
// section navigation from silently clearing or discarding a user's draft.

import { describe, expect, test } from 'vitest'
import {
  aggregateEditScopeRegistry,
  aggregateEditScopeStates,
  allowSameResourceSectionChange,
  createEditScopeChildAdapter,
  createEditScopeChildReport,
  createEditScopeRegistryState,
  createEditScopeState,
  editScopeReducer,
  editScopeRegistryReducer,
  shouldBlockEditScopeNavigation,
  type EditScopeChildReport,
  type EditScopeEvent,
  type EditScopeRegistryState,
  type EditScopeState,
} from '@/lib/edit-scope'

interface Value {
  value: string
}

const equalValue = (left: Value, right: Value) => left.value.trim() === right.value.trim()

function initial(value = 'server'): EditScopeState<Value> {
  return createEditScopeState({ value }, { validity: 'valid' })
}

function reduce(state: EditScopeState<Value>, event: EditScopeEvent<Value>): EditScopeState<Value> {
  return editScopeReducer(state, event, equalValue)
}

function edit(state: EditScopeState<Value>, value: string): EditScopeState<Value> {
  return reduce(state, { type: 'edit', draft: { value } })
}

function validate(state: EditScopeState<Value>): EditScopeState<Value> {
  return reduce(state, { type: 'validity', validity: 'valid' })
}

function begin(
  state: EditScopeState<Value>,
  requestId: string,
  submittedRevision = state.revision,
): EditScopeState<Value> {
  return reduce(state, { type: 'begin-submit', requestId, submittedRevision })
}

describe('RFC-201 edit scope — semantic draft and validity', () => {
  test('semantic equality is injected; every edit advances revision and must be revalidated', () => {
    let state = initial('same')

    state = edit(state, ' same ')

    expect(state).toMatchObject({
      draft: { value: ' same ' },
      baseline: { value: 'same' },
      revision: 1,
      dirty: false,
      validity: 'unknown',
    })
  })

  test('invalid/unknown dirty scope cannot begin submit and keeps a stable first-error target', () => {
    let state = edit(initial(), 'draft')
    expect(() => begin(state, 'req-unknown')).toThrow(/valid/i)

    state = reduce(state, {
      type: 'validity',
      validity: 'invalid',
      firstInvalidTarget: 'advanced-json',
    })
    expect(state.firstInvalidTarget).toBe('advanced-json')
    expect(() => begin(state, 'req-invalid')).toThrow(/valid/i)

    state = validate(state)
    expect(state.firstInvalidTarget).toBeUndefined()
    expect(() => begin(state, 'req-valid')).not.toThrow()
  })

  test('discard restores the current or supplied authoritative baseline', () => {
    let state = validate(edit(initial(), 'draft'))
    state = reduce(state, {
      type: 'remote-read',
      remote: { value: 'foreign' },
      issuedEpoch: 1,
    })
    expect(state.staleRemote).toEqual({ value: 'foreign' })

    state = reduce(state, { type: 'discard', baseline: { value: 'foreign' } })
    expect(state).toMatchObject({
      baseline: { value: 'foreign' },
      draft: { value: 'foreign' },
      dirty: false,
      validity: 'valid',
    })
    expect(state.staleRemote).toBeUndefined()
    expect(state.submitError).toBeUndefined()
  })
})

describe('RFC-201 edit scope — single-flight exact receipts', () => {
  test('begin-submit is single-flight and rejects every reused request id, even at one revision', () => {
    let state = begin(validate(edit(initial(), 'draft')), 'req-1')
    expect(state.inFlight).toMatchObject({
      requestId: 'req-1',
      submittedRevision: 1,
      submitted: { value: 'draft' },
    })

    expect(() => begin(state, 'req-2')).toThrow(/in.flight/i)

    state = reduce(state, {
      type: 'submit-error',
      requestId: 'req-1',
      submittedRevision: 1,
      error: new Error('rejected'),
      outcome: 'definitive',
    })
    expect(() => begin(state, 'req-1')).toThrow(/request.*id/i)

    state = begin(state, 'req-2')
    expect(state.inFlight?.requestId).toBe('req-2')
  })

  test('late success/error cannot settle a different current request', () => {
    const state = begin(validate(edit(initial(), 'draft')), 'req-current')

    const afterLateSuccess = reduce(state, {
      type: 'submit-success',
      requestId: 'req-old',
      submittedRevision: state.revision,
      persisted: { value: 'old-result' },
      ignoreReadsThroughEpoch: 4,
    })
    expect(afterLateSuccess).toBe(state)

    const afterLateError = reduce(state, {
      type: 'submit-error',
      requestId: 'req-old',
      submittedRevision: state.revision,
      error: new Error('late'),
      outcome: 'definitive',
    })
    expect(afterLateError).toBe(state)
    expect(afterLateError.inFlight?.requestId).toBe('req-current')

    const wrongRevision = reduce(state, {
      type: 'submit-success',
      requestId: 'req-current',
      submittedRevision: 0,
      persisted: { value: 'wrong-revision' },
    })
    expect(wrongRevision).toBe(state)
  })

  test('cancel-submit clears only the exact prepared attempt and keeps its request id consumed', () => {
    let state = begin(validate(edit(initial(), 'prepared')), 'req-prepared')

    expect(
      reduce(state, {
        type: 'cancel-submit',
        requestId: 'req-old',
        submittedRevision: state.revision,
      }),
    ).toBe(state)
    expect(
      reduce(state, {
        type: 'cancel-submit',
        requestId: 'req-prepared',
        submittedRevision: 0,
      }),
    ).toBe(state)

    state = reduce(state, {
      type: 'cancel-submit',
      requestId: 'req-prepared',
      submittedRevision: 1,
    })
    expect(state).toMatchObject({
      baseline: { value: 'server' },
      draft: { value: 'prepared' },
      dirty: true,
    })
    expect(state.inFlight).toBeUndefined()
    expect(() => begin(state, 'req-prepared')).toThrow(/request.*id/i)
    expect(() => begin(state, 'req-next')).not.toThrow()
  })

  test('matching success cleans an idle draft and establishes the read ignore floor', () => {
    let state = begin(validate(edit(initial(), 'submitted')), 'req-1')

    state = reduce(state, {
      type: 'submit-success',
      requestId: 'req-1',
      submittedRevision: 1,
      persisted: { value: 'normalized' },
      ignoreReadsThroughEpoch: 7,
    })

    expect(state).toMatchObject({
      baseline: { value: 'normalized' },
      draft: { value: 'normalized' },
      dirty: false,
      ignoreReadsThroughEpoch: 7,
    })
    expect(state.inFlight).toBeUndefined()
  })

  test('matching success advances only baseline when the user edited during submit', () => {
    let state = begin(validate(edit(initial(), 'submitted')), 'req-1')
    state = edit(state, 'newer')

    state = reduce(state, {
      type: 'submit-success',
      requestId: 'req-1',
      submittedRevision: 1,
      persisted: { value: 'submitted' },
      ignoreReadsThroughEpoch: 3,
    })

    expect(state).toMatchObject({
      revision: 2,
      baseline: { value: 'submitted' },
      draft: { value: 'newer' },
      dirty: true,
      validity: 'unknown',
    })
    expect(state.inFlight).toBeUndefined()
  })

  test('definitive error clears only matching busy state and preserves draft/baseline', () => {
    let state = begin(validate(edit(initial(), 'draft')), 'req-1')
    const error = new Error('400')

    state = reduce(state, {
      type: 'submit-error',
      requestId: 'req-1',
      submittedRevision: 1,
      error,
      outcome: 'definitive',
    })

    expect(state).toMatchObject({
      baseline: { value: 'server' },
      draft: { value: 'draft' },
      dirty: true,
      submitError: { requestId: 'req-1', submittedRevision: 1, error, outcome: 'definitive' },
    })
    expect(state.inFlight).toBeUndefined()
    expect(state.ambiguousSubmit).toBeUndefined()
  })
})

describe('RFC-201 edit scope — causal remote reads', () => {
  test('clean scope follows the newest acceptable remote snapshot', () => {
    const state = reduce(initial(), {
      type: 'remote-read',
      remote: { value: 'remote' },
      issuedEpoch: 2,
    })

    expect(state).toMatchObject({
      baseline: { value: 'remote' },
      draft: { value: 'remote' },
      dirty: false,
      lastAcceptedReadEpoch: 2,
    })
  })

  test('read at/below a write floor and read older than the last accepted epoch are ignored', () => {
    let state = begin(validate(edit(initial(), 'saved')), 'req-1')
    state = reduce(state, {
      type: 'submit-success',
      requestId: 'req-1',
      submittedRevision: 1,
      persisted: { value: 'saved' },
      ignoreReadsThroughEpoch: 5,
    })

    const atFloor = reduce(state, {
      type: 'remote-read',
      remote: { value: 'stale-a' },
      issuedEpoch: 5,
    })
    expect(atFloor).toBe(state)

    state = reduce(state, {
      type: 'remote-read',
      remote: { value: 'fresh' },
      issuedEpoch: 8,
    })
    const olderCompletion = reduce(state, {
      type: 'remote-read',
      remote: { value: 'stale-b' },
      issuedEpoch: 7,
    })
    expect(olderCompletion).toBe(state)
    expect(olderCompletion.draft).toEqual({ value: 'fresh' })
  })

  test('dirty remote equal to draft converges clean; same baseline is ignored; foreign is advisory', () => {
    let state = validate(edit(initial(), 'draft'))
    state = reduce(state, {
      type: 'remote-read',
      remote: { value: 'server' },
      issuedEpoch: 1,
    })
    expect(state).toMatchObject({ dirty: true, lastAcceptedReadEpoch: 1 })
    expect(state.staleRemote).toBeUndefined()

    state = reduce(state, {
      type: 'remote-read',
      remote: { value: 'foreign' },
      issuedEpoch: 2,
    })
    expect(state).toMatchObject({
      baseline: { value: 'server' },
      draft: { value: 'draft' },
      dirty: true,
      staleRemote: { value: 'foreign' },
    })

    state = reduce(state, {
      type: 'remote-read',
      remote: { value: ' draft ' },
      issuedEpoch: 3,
    })
    expect(state).toMatchObject({
      baseline: { value: ' draft ' },
      draft: { value: ' draft ' },
      dirty: false,
      lastAcceptedReadEpoch: 3,
    })
    expect(state.staleRemote).toBeUndefined()
  })
})

describe('RFC-201 edit scope — ambiguous submit recovery', () => {
  function ambiguous(): EditScopeState<Value> {
    let state = begin(validate(edit(initial(), 'submitted')), 'req-ambiguous')
    state = reduce(state, {
      type: 'submit-error',
      requestId: 'req-ambiguous',
      submittedRevision: 1,
      error: new Error('connection lost'),
      outcome: 'ambiguous',
    })
    return state
  }

  test('ambiguous error preserves the exact intent and blocks blind retry', () => {
    const state = ambiguous()
    expect(state).toMatchObject({
      dirty: true,
      ambiguousSubmit: {
        requestId: 'req-ambiguous',
        submittedRevision: 1,
        submitted: { value: 'submitted' },
      },
      submitError: { outcome: 'ambiguous' },
    })
    expect(state.inFlight).toBeUndefined()
    expect(() => begin(state, 'req-retry')).toThrow(/reconcile/i)
  })

  test('ambient or mismatched remote===draft cannot falsely resolve outcome-unknown', () => {
    const state = ambiguous()
    const ambient = reduce(state, {
      type: 'remote-read',
      remote: { value: 'submitted' },
      issuedEpoch: 2,
    })
    expect(ambient.dirty).toBe(true)
    expect(ambient.ambiguousSubmit).toBeDefined()

    const mismatched = reduce(ambient, {
      type: 'remote-read',
      remote: { value: 'submitted' },
      issuedEpoch: 3,
      reconciliation: { requestId: 'req-old', submittedRevision: 1 },
    })
    expect(mismatched.dirty).toBe(true)
    expect(mismatched.ambiguousSubmit).toBeDefined()
  })

  test('matching authoritative reconcile cleans only the submitted revision', () => {
    let state = ambiguous()
    state = reduce(state, {
      type: 'remote-read',
      remote: { value: 'submitted' },
      issuedEpoch: 2,
      reconciliation: { requestId: 'req-ambiguous', submittedRevision: 1 },
    })
    expect(state).toMatchObject({
      baseline: { value: 'submitted' },
      draft: { value: 'submitted' },
      dirty: false,
    })
    expect(state.ambiguousSubmit).toBeUndefined()
    expect(state.submitError).toBeUndefined()
  })

  test('matching late reconcile advances baseline but never clears a newer edit', () => {
    let state = edit(ambiguous(), 'newer')
    state = reduce(state, {
      type: 'remote-read',
      remote: { value: 'submitted' },
      issuedEpoch: 2,
      reconciliation: { requestId: 'req-ambiguous', submittedRevision: 1 },
    })

    expect(state).toMatchObject({
      revision: 2,
      baseline: { value: 'submitted' },
      draft: { value: 'newer' },
      dirty: true,
    })
    expect(state.ambiguousSubmit).toBeUndefined()
  })

  test('matching authoritative non-application clears outcome-unknown but keeps the draft dirty', () => {
    let state = ambiguous()
    state = reduce(state, {
      type: 'remote-read',
      remote: { value: 'server' },
      issuedEpoch: 2,
      reconciliation: { requestId: 'req-ambiguous', submittedRevision: 1 },
    })

    expect(state).toMatchObject({
      baseline: { value: 'server' },
      draft: { value: 'submitted' },
      dirty: true,
    })
    expect(state.ambiguousSubmit).toBeUndefined()
    expect(state.submitError).toBeUndefined()
    expect(() => begin(state, 'req-fresh')).not.toThrow()
  })
})

describe('RFC-201 edit scope — aggregation and navigation predicate', () => {
  test('aggregate exposes dirty/busy/valid/stale/outcome-unknown and first invalid target', () => {
    const clean = initial('clean')
    const invalid = reduce(edit(initial('a'), 'b'), {
      type: 'validity',
      validity: 'invalid',
      firstInvalidTarget: 'field-b',
    })
    let busy = begin(validate(edit(initial('c'), 'd')), 'req-busy')
    busy = reduce(busy, {
      type: 'remote-read',
      remote: { value: 'foreign' },
      issuedEpoch: 1,
    })

    expect(aggregateEditScopeStates([clean, invalid, busy])).toEqual({
      dirty: true,
      busy: true,
      valid: false,
      stale: true,
      outcomeUnknown: false,
      firstInvalidTarget: 'field-b',
    })
  })

  const options = {
    sectionKeys: ['tab'] as const,
    resourceIdentity: (location: { pathname: string }) =>
      location.pathname.startsWith('/agents/') ? location.pathname.slice('/agents/'.length) : null,
  }

  test('only a registered section-key change on the exact same resource is allowed', () => {
    const current = {
      pathname: '/agents/alpha',
      search: { tab: 'edit', focus: 'name' },
      hash: '',
    }
    expect(
      allowSameResourceSectionChange(
        current,
        { ...current, search: { tab: 'resources', focus: 'name' } },
        options,
      ),
    ).toBe(true)
    expect(
      allowSameResourceSectionChange(
        current,
        { ...current, search: { tab: 'resources', focus: 'runtime' } },
        options,
      ),
    ).toBe(false)
    expect(
      allowSameResourceSectionChange(
        current,
        { pathname: '/agents/beta', search: { tab: 'resources', focus: 'name' }, hash: '' },
        options,
      ),
    ).toBe(false)
    expect(
      allowSameResourceSectionChange(current, { ...current, hash: '#advanced' }, options),
    ).toBe(false)
  })

  test('dirty allows the narrow section change, while mutating busy blocks every navigation', () => {
    const current = { pathname: '/agents/alpha', search: { tab: 'edit' } }
    const next = { pathname: '/agents/alpha', search: { tab: 'resources' } }

    expect(
      shouldBlockEditScopeNavigation({ dirty: true, busy: false }, current, next, options),
    ).toBe(false)
    expect(
      shouldBlockEditScopeNavigation({ dirty: true, busy: true }, current, next, options),
    ).toBe(true)
    expect(
      shouldBlockEditScopeNavigation(
        { dirty: false, busy: false },
        current,
        { pathname: '/agents/beta', search: { tab: 'edit' } },
        options,
      ),
    ).toBe(false)
  })
})

const cleanReport: EditScopeChildReport = {
  dirty: false,
  busy: false,
  valid: true,
  stale: false,
  outcomeUnknown: false,
}

function registerScope(
  state: EditScopeRegistryState,
  scopeId: string,
  registrationId: string,
  report: EditScopeChildReport = cleanReport,
): EditScopeRegistryState {
  const adapter = createEditScopeChildAdapter({
    scopeId,
    registrationId,
    generation: state.generation,
  })
  return editScopeRegistryReducer(state, adapter.register(report))
}

describe('RFC-201 route-local edit scope registry and child adapter', () => {
  test('child report projection preserves submit gates without exposing draft data', () => {
    let scope = edit(initial(), 'raw-invalid')
    scope = reduce(scope, {
      type: 'validity',
      validity: 'invalid',
      firstInvalidTarget: 'advanced-json',
    })

    expect(createEditScopeChildReport(scope)).toEqual({
      dirty: true,
      busy: false,
      valid: false,
      stale: false,
      outcomeUnknown: false,
      firstInvalidTarget: 'advanced-json',
    })
  })

  test('multiple scopes aggregate in registration order and expose the first invalid target', () => {
    let registry = createEditScopeRegistryState('agent:alpha')
    registry = registerScope(registry, 'metadata', 'metadata-1', {
      ...cleanReport,
      dirty: true,
      valid: false,
      firstInvalidTarget: 'agent-name',
    })
    registry = registerScope(registry, 'advanced', 'advanced-1', {
      ...cleanReport,
      dirty: true,
      busy: true,
      valid: false,
      stale: true,
      outcomeUnknown: true,
      firstInvalidTarget: 'advanced-json',
    })

    expect(aggregateEditScopeRegistry(registry)).toEqual({
      dirty: true,
      busy: true,
      valid: false,
      stale: true,
      outcomeUnknown: true,
      firstInvalidTarget: 'agent-name',
    })
  })

  test('partial success updates only the matching scope report', () => {
    let registry = createEditScopeRegistryState('skill:one')
    registry = registerScope(registry, 'metadata', 'metadata-1', {
      ...cleanReport,
      dirty: true,
      busy: true,
    })
    registry = registerScope(registry, 'file:a.md', 'file-1', {
      ...cleanReport,
      dirty: true,
      busy: true,
    })

    const metadata = createEditScopeChildAdapter({
      scopeId: 'metadata',
      registrationId: 'metadata-1',
      generation: registry.generation,
    })
    registry = editScopeRegistryReducer(registry, metadata.report(cleanReport))

    expect(registry.scopes.get('metadata')?.report).toEqual(cleanReport)
    expect(registry.scopes.get('file:a.md')?.report).toMatchObject({ dirty: true, busy: true })
    expect(aggregateEditScopeRegistry(registry)).toMatchObject({ dirty: true, busy: true })
  })

  test('identity reset clears every scope and fences reports from the old generation', () => {
    let registry = createEditScopeRegistryState('agent:alpha')
    const oldChild = createEditScopeChildAdapter({
      scopeId: 'basics',
      registrationId: 'basics-alpha',
      generation: registry.generation,
    })
    registry = editScopeRegistryReducer(
      registry,
      oldChild.register({ ...cleanReport, dirty: true }),
    )

    registry = editScopeRegistryReducer(registry, {
      type: 'reset-identity',
      identity: 'agent:beta',
    })
    expect(registry).toMatchObject({ identity: 'agent:beta', generation: 1 })
    expect(registry.scopes.size).toBe(0)
    expect(
      editScopeRegistryReducer(
        registry,
        oldChild.report({ ...cleanReport, dirty: true, stale: true }),
      ),
    ).toBe(registry)
  })

  test('replacement registration ignores late report and unregister from the old child', () => {
    let registry = createEditScopeRegistryState('settings')
    const oldChild = createEditScopeChildAdapter({
      scopeId: 'limits',
      registrationId: 'limits-old',
      generation: registry.generation,
    })
    const currentChild = createEditScopeChildAdapter({
      scopeId: 'limits',
      registrationId: 'limits-current',
      generation: registry.generation,
    })
    registry = editScopeRegistryReducer(
      registry,
      oldChild.register({ ...cleanReport, dirty: true }),
    )
    registry = editScopeRegistryReducer(registry, currentChild.register(cleanReport))

    expect(
      editScopeRegistryReducer(
        registry,
        oldChild.report({ ...cleanReport, dirty: true, outcomeUnknown: true }),
      ),
    ).toBe(registry)
    expect(editScopeRegistryReducer(registry, oldChild.unregister())).toBe(registry)
    expect(registry.scopes.get('limits')).toEqual({
      scopeId: 'limits',
      registrationId: 'limits-current',
      report: cleanReport,
    })

    registry = editScopeRegistryReducer(registry, currentChild.unregister())
    expect(registry.scopes.size).toBe(0)
    expect(
      editScopeRegistryReducer(
        registry,
        currentChild.report({ ...cleanReport, dirty: true, stale: true }),
      ),
    ).toBe(registry)
  })
})
