// RFC-194 T1 — locks the atomic port-state contract behind the Agent editor.
// A future UI refactor must not turn rename/delete into partial sidecar writes,
// silently consume legacy orphan data, or collapse an explicit {} clear into
// an omitted sparse-patch field.

import { describe, expect, test } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import {
  addInputPort,
  addOutputPort,
  findOrphanOutputSidecars,
  removeInputPort,
  removeOrphanOutputSidecars,
  removeOutputPort,
  replaceInputPort,
  replaceOutputPort,
  validateAgentPortState,
  validatePortName,
  type OutputPortState,
} from '../src/lib/agent-ports'
import { agentToPutBody } from '../src/routes/agents.detail'

describe('RFC-194 validatePortName', () => {
  test('trims new names and accepts the canonical grammar', () => {
    expect(
      validatePortName({
        raw: '  report_2  ',
        direction: 'output',
        existingNames: [],
      }),
    ).toEqual({ ok: true, value: 'report_2', legacyPassThrough: false })
  })

  test('distinguishes required, format, and input length failures', () => {
    expect(validatePortName({ raw: '   ', direction: 'input', existingNames: [] })).toEqual({
      ok: false,
      reason: 'required',
    })
    expect(validatePortName({ raw: '2report', direction: 'output', existingNames: [] })).toEqual({
      ok: false,
      reason: 'format',
    })
    expect(
      validatePortName({ raw: 'a'.repeat(128), direction: 'input', existingNames: [] }),
    ).toMatchObject({ ok: true, value: 'a'.repeat(128) })
    expect(
      validatePortName({ raw: 'a'.repeat(129), direction: 'input', existingNames: [] }),
    ).toEqual({ ok: false, reason: 'too-long' })
  })

  test('excludes the edited index but still detects another duplicate', () => {
    expect(
      validatePortName({
        raw: 'report',
        direction: 'output',
        existingNames: ['report', 'other'],
        editingIndex: 0,
        originalName: 'report',
      }),
    ).toEqual({ ok: true, value: 'report', legacyPassThrough: false })
    expect(
      validatePortName({
        raw: 'report',
        direction: 'output',
        existingNames: ['report', 'report'],
        editingIndex: 0,
        originalName: 'report',
      }),
    ).toEqual({ ok: false, reason: 'duplicate' })
  })

  test('passes a unique unchanged legacy name byte-for-byte but validates any rename', () => {
    expect(
      validatePortName({
        raw: 'Legacy-Port ',
        direction: 'output',
        existingNames: ['Legacy-Port '],
        editingIndex: 0,
        originalName: 'Legacy-Port ',
      }),
    ).toEqual({ ok: true, value: 'Legacy-Port ', legacyPassThrough: true })
    expect(
      validatePortName({
        raw: 'Legacy-Port',
        direction: 'output',
        existingNames: ['Legacy-Port '],
        editingIndex: 0,
        originalName: 'Legacy-Port ',
      }),
    ).toEqual({ ok: false, reason: 'format' })
  })

  test('does not let legacy pass-through bypass the input schema boundary', () => {
    const name = 'a'.repeat(129)
    expect(
      validatePortName({
        raw: name,
        direction: 'input',
        existingNames: [name],
        editingIndex: 0,
        originalName: name,
      }),
    ).toEqual({ ok: false, reason: 'too-long' })
  })
})

describe('RFC-194 input port mutations', () => {
  test('adds a compact canonical value without mutating the input', () => {
    const inputs = Object.freeze([{ name: 'request', kind: 'string' }])
    const next = addInputPort(inputs, {
      name: '  repo  ',
      kind: 'path<*>',
      required: false,
      description: '  repository root  ',
    })

    expect(next).toEqual([
      { name: 'request', kind: 'string' },
      { name: 'repo', kind: 'path<*>', description: 'repository root' },
    ])
    expect(inputs).toEqual([{ name: 'request', kind: 'string' }])
  })

  test('replaces the full port and preserves an unchanged legacy identity', () => {
    const inputs = [{ name: 'Legacy Input', kind: 'string', description: 'old' }]
    const next = replaceInputPort(inputs, 0, {
      name: 'Legacy Input',
      kind: 'list<string>',
      required: true,
      description: '  new description ',
    })
    expect(next).toEqual([
      {
        name: 'Legacy Input',
        kind: 'list<string>',
        required: true,
        description: 'new description',
      },
    ])
    expect(inputs).toEqual([{ name: 'Legacy Input', kind: 'string', description: 'old' }])
  })

  test('removes only the selected index and stale indices are harmless', () => {
    const inputs = [
      { name: 'a', kind: 'string' },
      { name: 'b', kind: 'markdown' },
    ]
    expect(removeInputPort(inputs, 0)).toEqual([{ name: 'b', kind: 'markdown' }])
    expect(removeInputPort(inputs, 9)).toEqual(inputs)
    expect(inputs).toHaveLength(2)
  })
})

describe('RFC-194 output port mutations', () => {
  test('adds a default string port without creating either sidecar map', () => {
    const state = Object.freeze({ outputs: Object.freeze(['existing']) })
    const result = addOutputPort(state, { name: '  report ', kind: 'string' }, { role: 'normal' })
    expect(result).toEqual({
      ok: true,
      state: {
        outputs: ['existing', 'report'],
        outputKinds: undefined,
        outputWrapperPortNames: undefined,
      },
    })
    expect(state.outputs).toEqual(['existing'])
  })

  test('adds an aggregator kind and wrapper mapping together', () => {
    const result = addOutputPort(
      { outputs: [] },
      { name: 'report', kind: 'path<md>', wrapperPortName: 'final' },
      { role: 'aggregator' },
    )
    expect(result).toEqual({
      ok: true,
      state: {
        outputs: ['report'],
        outputKinds: { report: 'path<md>' },
        outputWrapperPortNames: { report: 'final' },
      },
    })
  })

  test('renames in order and atomically migrates both maps without touching siblings', () => {
    const state: OutputPortState = {
      outputs: Object.freeze(['before', 'report', 'after']),
      outputKinds: Object.freeze({ report: 'path<md>', after: 'signal' }),
      outputWrapperPortNames: Object.freeze({ report: 'final', after: 'done' }),
    }
    const snapshot = structuredClone(state)
    const result = replaceOutputPort(
      state,
      1,
      { name: 'summary', kind: 'list<string>', wrapperPortName: 'published' },
      { role: 'aggregator' },
    )
    expect(result).toEqual({
      ok: true,
      state: {
        outputs: ['before', 'summary', 'after'],
        outputKinds: { summary: 'list<string>', after: 'signal' },
        outputWrapperPortNames: { summary: 'published', after: 'done' },
      },
    })
    expect(state).toEqual(snapshot)
  })

  test('normal rename migrates its hidden valid wrapper map and ignores a hidden draft write', () => {
    const result = replaceOutputPort(
      {
        outputs: ['report'],
        outputKinds: { report: 'markdown' },
        outputWrapperPortNames: { report: 'final' },
      },
      0,
      { name: 'summary', kind: 'path<md>', wrapperPortName: 'must-not-apply' },
      { role: 'normal' },
    )
    expect(result).toEqual({
      ok: true,
      state: {
        outputs: ['summary'],
        outputKinds: { summary: 'path<md>' },
        outputWrapperPortNames: { summary: 'final' },
      },
    })
  })

  test('normal kind edit preserves the hidden wrapper mapping at the same key', () => {
    const result = replaceOutputPort(
      {
        outputs: ['report'],
        outputKinds: { report: 'markdown' },
        outputWrapperPortNames: { report: 'final' },
      },
      0,
      { name: 'report', kind: 'path<md>' },
      { role: 'normal' },
    )
    expect(result).toMatchObject({
      ok: true,
      state: {
        outputKinds: { report: 'path<md>' },
        outputWrapperPortNames: { report: 'final' },
      },
    })
  })

  test('renaming one legacy duplicate keeps the shared old sidecars for the remaining item', () => {
    const result = replaceOutputPort(
      {
        outputs: ['report', 'report'],
        outputKinds: { report: 'markdown' },
        outputWrapperPortNames: { report: 'final' },
      },
      0,
      { name: 'summary', kind: 'path<md>', wrapperPortName: 'published' },
      { role: 'aggregator' },
    )
    expect(result).toEqual({
      ok: true,
      state: {
        outputs: ['summary', 'report'],
        outputKinds: { report: 'markdown', summary: 'path<md>' },
        outputWrapperPortNames: { report: 'final', summary: 'published' },
      },
    })
  })

  test('an unchanged duplicate cannot be used to edit kind or required sidecars', () => {
    const state = {
      outputs: ['report', 'report'],
      outputKinds: { report: 'markdown' },
      outputWrapperPortNames: { report: 'final' },
    }
    const snapshot = structuredClone(state)
    expect(
      replaceOutputPort(
        state,
        0,
        { name: 'report', kind: 'path<md>', wrapperPortName: 'changed' },
        { role: 'aggregator' },
      ),
    ).toEqual({ ok: false, reason: 'name-duplicate' })
    expect(state).toEqual(snapshot)
  })

  test('deleting one duplicate preserves sidecars; deleting the last one creates tombstones', () => {
    const once = removeOutputPort(
      {
        outputs: ['report', 'report'],
        outputKinds: { report: 'markdown' },
        outputWrapperPortNames: { report: 'final' },
      },
      0,
    )
    expect(once).toEqual({
      outputs: ['report'],
      outputKinds: { report: 'markdown' },
      outputWrapperPortNames: { report: 'final' },
    })
    expect(removeOutputPort(once, 0)).toEqual({
      outputs: [],
      outputKinds: {},
      outputWrapperPortNames: {},
    })
  })

  test('delete clears both maps but leaves untouched absent sidecars undefined', () => {
    const state = {
      outputs: ['report', 'keep'],
      outputKinds: { report: 'markdown', keep: 'signal' },
      outputWrapperPortNames: { report: 'final', keep: 'kept' },
    }
    const snapshot = structuredClone(state)
    expect(removeOutputPort(state, 0)).toEqual({
      outputs: ['keep'],
      outputKinds: { keep: 'signal' },
      outputWrapperPortNames: { keep: 'kept' },
    })
    expect(state).toEqual(snapshot)
    expect(removeOutputPort({ outputs: ['report'] }, 0)).toEqual({
      outputs: [],
      outputKinds: undefined,
      outputWrapperPortNames: undefined,
    })
  })

  test('blank/same-name wrapper values clear the key, while unchanged legacy text is preserved', () => {
    const cleared = replaceOutputPort(
      {
        outputs: ['report'],
        outputWrapperPortNames: { report: 'final' },
      },
      0,
      { name: 'report', kind: 'string', wrapperPortName: ' report ' },
      { role: 'aggregator' },
    )
    expect(cleared).toMatchObject({ ok: true, state: { outputWrapperPortNames: {} } })

    const legacy = replaceOutputPort(
      {
        outputs: ['report'],
        outputWrapperPortNames: { report: ' final ' },
      },
      0,
      { name: 'report', kind: 'string', wrapperPortName: ' final ' },
      { role: 'aggregator' },
    )
    expect(legacy).toMatchObject({
      ok: true,
      state: { outputWrapperPortNames: { report: ' final ' } },
    })
  })

  test('fails closed on stale index, invalid name/kind, name collision, and wrapper collision', () => {
    const state = Object.freeze({
      outputs: Object.freeze(['a']),
      outputKinds: Object.freeze({ a: 'string' }),
      outputWrapperPortNames: Object.freeze({ a: 'shared' }),
    })
    expect(replaceOutputPort(state, 9, { name: 'b', kind: 'string' }, { role: 'normal' })).toEqual({
      ok: false,
      reason: 'index-out-of-range',
    })
    expect(addOutputPort(state, { name: 'Bad', kind: 'string' }, { role: 'normal' })).toEqual({
      ok: false,
      reason: 'name-invalid',
    })
    expect(addOutputPort(state, { name: 'b', kind: 'html' }, { role: 'normal' })).toEqual({
      ok: false,
      reason: 'kind-invalid',
    })
    expect(addOutputPort(state, { name: 'a', kind: 'string' }, { role: 'normal' })).toEqual({
      ok: false,
      reason: 'name-duplicate',
    })
    expect(
      addOutputPort(
        state,
        { name: 'b', kind: 'string', wrapperPortName: 'shared' },
        { role: 'aggregator' },
      ),
    ).toEqual({ ok: false, reason: 'wrapper-duplicate' })
    expect(state).toEqual({
      outputs: ['a'],
      outputKinds: { a: 'string' },
      outputWrapperPortNames: { a: 'shared' },
    })
  })

  test('normal add still fails when the new name occupies a wrapper orphan key', () => {
    expect(
      addOutputPort(
        { outputs: [], outputWrapperPortNames: { report: 'legacy' } },
        { name: 'report', kind: 'string' },
        { role: 'normal' },
      ),
    ).toEqual({ ok: false, reason: 'orphan-key-conflict' })
  })

  test('rename fails on an orphan key in either map without changing any source state', () => {
    for (const state of [
      { outputs: ['old'], outputKinds: { occupied: 'markdown' } },
      { outputs: ['old'], outputWrapperPortNames: { occupied: 'legacy' } },
    ]) {
      const snapshot = structuredClone(state)
      expect(
        replaceOutputPort(state, 0, { name: 'occupied', kind: 'string' }, { role: 'normal' }),
      ).toEqual({ ok: false, reason: 'orphan-key-conflict' })
      expect(state).toEqual(snapshot)
    }
  })
})

describe('RFC-194 orphan sidecar repair', () => {
  test('finds both sources in deterministic, source-explicit order', () => {
    expect(
      findOrphanOutputSidecars({
        outputs: ['declared'],
        outputKinds: { declared: 'string', ghost: 'markdown' },
        outputWrapperPortNames: { ghost: 'legacy', other: 'published' },
      }),
    ).toEqual([
      { source: 'outputKinds', key: 'ghost' },
      { source: 'outputWrapperPortNames', key: 'ghost' },
      { source: 'outputWrapperPortNames', key: 'other' },
    ])
  })

  test('same key in both sources is cleaned one confirmation at a time', () => {
    const state = {
      outputs: ['declared'],
      outputKinds: { ghost: 'markdown' },
      outputWrapperPortNames: { ghost: 'published' },
    }
    const afterKind = removeOrphanOutputSidecars(state, [{ source: 'outputKinds', key: 'ghost' }])
    expect(afterKind).toEqual({
      outputs: ['declared'],
      outputKinds: {},
      outputWrapperPortNames: { ghost: 'published' },
    })
    expect(state).toEqual({
      outputs: ['declared'],
      outputKinds: { ghost: 'markdown' },
      outputWrapperPortNames: { ghost: 'published' },
    })

    expect(
      removeOrphanOutputSidecars(afterKind, [{ source: 'outputWrapperPortNames', key: 'ghost' }]),
    ).toEqual({
      outputs: ['declared'],
      outputKinds: {},
      outputWrapperPortNames: {},
    })
  })

  test('stale repair refs never delete sidecars for a now-declared port', () => {
    const state = {
      outputs: ['report'],
      outputKinds: { report: 'markdown' },
      outputWrapperPortNames: { report: 'final' },
    }
    expect(
      removeOrphanOutputSidecars(state, [
        { source: 'outputKinds', key: 'report' },
        { source: 'outputWrapperPortNames', key: 'report' },
      ]),
    ).toEqual(state)
  })
})

describe('RFC-194 sparse PUT tombstones', () => {
  test('agentToPutBody JSON includes both explicit empty maps after the last output is deleted', () => {
    const cleared = removeOutputPort(
      {
        outputs: ['report'],
        outputKinds: { report: 'markdown' },
        outputWrapperPortNames: { report: 'final' },
      },
      0,
    )
    const base: CreateAgent = {
      name: 'demo',
      description: '',
      outputs: cleared.outputs,
      outputKinds: cleared.outputKinds,
      outputWrapperPortNames: cleared.outputWrapperPortNames,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: { sibling: true },
      bodyMd: '',
    }
    const wire = JSON.parse(JSON.stringify(agentToPutBody(base))) as Record<string, unknown>
    expect(wire.outputKinds).toEqual({})
    expect(wire.outputWrapperPortNames).toEqual({})
    expect(wire.frontmatterExtra).toEqual({ sibling: true })
  })
})

describe('RFC-194 validateAgentPortState', () => {
  test('accepts unique schema-readable legacy names without forcing the UI regex', () => {
    // RFC-218: a name that cannot ride a `{{token}}` now yields an ADVISORY
    // warning (the agent won't be manually launchable) — but the RFC-194
    // contract holds: legacy names never block the save (valid stays true).
    expect(
      validateAgentPortState({
        inputs: [{ name: 'Legacy Input' }],
        outputs: ['Legacy Output'],
        outputKinds: { 'Legacy Output': 'markdown' },
      }),
    ).toEqual({
      valid: true,
      issues: [
        {
          severity: 'warning',
          repairTarget: 'ports',
          code: 'input-name-launch-blocked',
          index: 0,
          name: 'Legacy Input',
        },
      ],
    })
  })

  test('reports input schema and duplicate identities as blocking Ports repairs', () => {
    const result = validateAgentPortState({
      inputs: [{ name: '' }, { name: 'dup' }, { name: 'dup' }, { name: 'a'.repeat(129) }],
    })
    expect(result.valid).toBe(false)
    expect(result.issues.filter((issue) => issue.code === 'input-name-schema')).toHaveLength(2)
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        repairTarget: 'ports',
        code: 'input-name-duplicate',
        name: 'dup',
        indices: [1, 2],
      }),
    )
  })

  test('reports one blocking issue for each duplicated output identity', () => {
    const result = validateAgentPortState({ outputs: ['a', 'a', 'b', 'b'] })
    expect(result.valid).toBe(false)
    expect(result.issues.filter((issue) => issue.code === 'output-name-duplicate')).toEqual([
      expect.objectContaining({ name: 'a', indices: [0, 1], severity: 'error' }),
      expect.objectContaining({ name: 'b', indices: [2, 3], severity: 'error' }),
    ])
  })

  test('invalid kinds block both declared and orphan entries; orphan also remains repairable', () => {
    const result = validateAgentPortState({
      outputs: ['declared'],
      outputKinds: { declared: 'html', ghost: 'list<html>' },
    })
    expect(result.valid).toBe(false)
    expect(result.issues.filter((issue) => issue.code === 'output-kind-invalid')).toEqual([
      expect.objectContaining({ key: 'declared', severity: 'error', repairTarget: 'ports' }),
      expect.objectContaining({ key: 'ghost', severity: 'error', repairTarget: 'ports' }),
    ])
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        key: 'ghost',
        code: 'orphan-output-kind',
        severity: 'warning',
      }),
    )
  })

  test('reserved sidecars in frontmatterExtra block Save and point to Advanced', () => {
    const result = validateAgentPortState({
      frontmatterExtra: {
        outputKinds: { report: 'markdown' },
        role: 'aggregator',
        outputWrapperPortNames: { report: 'final' },
        sibling: true,
      },
    })
    expect(result.valid).toBe(false)
    expect(
      result.issues
        .filter((issue) => issue.code === 'reserved-port-sidecar-key')
        .map((issue) => [issue.key, issue.repairTarget, issue.severity]),
    ).toEqual([
      ['outputKinds', 'advanced', 'error'],
      ['role', 'advanced', 'error'],
      ['outputWrapperPortNames', 'advanced', 'error'],
    ])
  })

  test('effective wrapper collisions block aggregators but are warnings for normal agents', () => {
    const draft = {
      outputs: ['left', 'right'],
      outputWrapperPortNames: { right: 'left' },
    }
    const aggregator = validateAgentPortState({ ...draft, role: 'aggregator' })
    expect(aggregator.valid).toBe(false)
    expect(aggregator.issues).toContainEqual(
      expect.objectContaining({
        code: 'wrapper-name-duplicate',
        name: 'left',
        severity: 'error',
        repairTarget: 'ports',
      }),
    )

    const normal = validateAgentPortState({ ...draft, role: 'normal' })
    expect(normal.valid).toBe(true)
    expect(normal.issues).toContainEqual(
      expect.objectContaining({
        code: 'wrapper-name-duplicate',
        severity: 'warning',
        repairTarget: 'advanced',
      }),
    )
  })

  test('both orphan sources are non-blocking warnings with precise repair metadata', () => {
    const result = validateAgentPortState({
      outputs: ['declared'],
      outputKinds: { ghost: 'markdown' },
      outputWrapperPortNames: { ghost: 'published' },
    })
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'orphan-output-kind',
        severity: 'warning',
        repairTarget: 'ports',
        source: 'outputKinds',
        key: 'ghost',
      }),
      expect.objectContaining({
        code: 'orphan-wrapper-name',
        severity: 'warning',
        repairTarget: 'ports',
        source: 'outputWrapperPortNames',
        key: 'ghost',
      }),
    ])
  })
})
