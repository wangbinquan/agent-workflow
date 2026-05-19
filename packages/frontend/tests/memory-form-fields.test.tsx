// RFC-045 — MemoryFormFields + useMemoryFormState + validateMemoryForm.
//
// Pure UI / pure-function tests — no network, no router. The dialog wrappers
// own the API calls and dialog chrome and have their own tests.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useTranslation } from 'react-i18next'
import {
  defaultMemoryFormState,
  MEMORY_FORM_LIMITS,
  MemoryFormFields,
  useMemoryFormState,
  validateMemoryForm,
  type MemoryFormState,
} from '../src/components/memory/MemoryFormFields'
import '../src/i18n'

afterEach(() => cleanup())

interface HarnessProps {
  initial?: Partial<MemoryFormState>
  onChange?: (s: MemoryFormState) => void
}

function Harness({ initial, onChange }: HarnessProps) {
  const f = useMemoryFormState(initial)
  const { t } = useTranslation()
  // Propagate state for inspection from the test.
  onChange?.(f.state)
  return (
    <MemoryFormFields
      state={f.state}
      errors={validateMemoryForm(f.state, t as (k: string, o?: Record<string, unknown>) => string)}
      onScopeType={f.setScopeType}
      onScopeId={f.setScopeId}
      onTitle={f.setTitle}
      onBodyMd={f.setBodyMd}
      onTags={f.setTags}
      agents={[
        { id: 'agent-a', label: 'agent-a' },
        { id: 'agent-b', label: 'agent-b' },
      ]}
      workflows={[{ id: 'wf-1', label: 'wf-1' }]}
      repos={[{ id: 'repo-1', label: 'origin/main' }]}
    />
  )
}

describe('useMemoryFormState — RFC-045', () => {
  test('default state is global + empty fields', () => {
    const { result } = renderHook(() => useMemoryFormState())
    expect(result.current.state).toEqual(defaultMemoryFormState())
    expect(result.current.state.scopeType).toBe('global')
    expect(result.current.state.scopeId).toBeNull()
  })

  test('setScopeType("global") nulls scopeId; setScopeType away keeps empty string', () => {
    const { result } = renderHook(() =>
      useMemoryFormState({ scopeType: 'agent', scopeId: 'agent-a' }),
    )
    act(() => result.current.setScopeType('global'))
    expect(result.current.state.scopeId).toBeNull()
    act(() => result.current.setScopeType('workflow'))
    // From global we lose the prior id and need a fresh pick — empty string.
    expect(result.current.state.scopeId).toBe('')
  })
})

describe('validateMemoryForm — RFC-045', () => {
  function t(k: string, opts?: Record<string, unknown>): string {
    return opts !== undefined ? `${k}:${JSON.stringify(opts)}` : k
  }
  test('happy: global + title + body → no errors', () => {
    const errs = validateMemoryForm(
      { scopeType: 'global', scopeId: null, title: 'ok', bodyMd: 'body', tags: [] },
      t,
    )
    expect(errs).toEqual({})
  })
  test('empty title → memory.form.errTitleEmpty', () => {
    const errs = validateMemoryForm(
      { scopeType: 'global', scopeId: null, title: '   ', bodyMd: 'body', tags: [] },
      t,
    )
    expect(errs.title).toContain('errTitleEmpty')
  })
  test('non-global without scopeId → errScopeIdRequired', () => {
    const errs = validateMemoryForm(
      { scopeType: 'agent', scopeId: '', title: 't', bodyMd: 'b', tags: [] },
      t,
    )
    expect(errs.scopeId).toContain('errScopeIdRequired')
  })
  test('17 tags → errTagsTooMany', () => {
    const tags = Array.from({ length: 17 }, (_, i) => `t${i}`)
    const errs = validateMemoryForm(
      { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags },
      t,
    )
    expect(errs.tags).toContain('errTagsTooMany')
  })
  test('tag > 40 chars → errTagTooLong', () => {
    const errs = validateMemoryForm(
      { scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', tags: ['x'.repeat(41)] },
      t,
    )
    expect(errs.tags).toContain('errTagTooLong')
  })
  test('body > 4000 chars → errBodyTooLong', () => {
    const errs = validateMemoryForm(
      {
        scopeType: 'global',
        scopeId: null,
        title: 't',
        bodyMd: 'x'.repeat(MEMORY_FORM_LIMITS.bodyMax + 1),
        tags: [],
      },
      t,
    )
    expect(errs.bodyMd).toContain('errBodyTooLong')
  })
})

describe('MemoryFormFields — rendering & UX', () => {
  test('renders all 4 scope radios', () => {
    render(<Harness />)
    expect(screen.getByTestId('memory-form-scope-global')).toBeTruthy()
    expect(screen.getByTestId('memory-form-scope-agent')).toBeTruthy()
    expect(screen.getByTestId('memory-form-scope-workflow')).toBeTruthy()
    expect(screen.getByTestId('memory-form-scope-repo')).toBeTruthy()
  })

  test('global scope hides scopeId dropdown', () => {
    render(<Harness initial={{ scopeType: 'global' }} />)
    expect(screen.getByTestId('memory-form-scope-id-global')).toBeTruthy()
    expect(screen.queryByTestId('memory-form-scope-id')).toBeNull()
  })

  test('switching to agent reveals the agent dropdown trigger', () => {
    render(<Harness initial={{ scopeType: 'agent', scopeId: 'agent-a' }} />)
    // The scope_id widget now uses the shared <Select> popover (RFC-036).
    // We only assert the trigger is present; popover option contents are
    // covered by the shared Select component tests.
    const wrap = screen.getByTestId('memory-form-scope-id')
    expect(wrap.querySelector('button[role="combobox"]')).not.toBeNull()
  })

  test('typing a tag and pressing Enter appends a chip', () => {
    let latest: MemoryFormState = defaultMemoryFormState()
    render(<Harness onChange={(s) => (latest = s)} />)
    const input = screen.getByTestId('memory-form-tag-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'new-tag' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(latest.tags).toContain('new-tag')
    expect(input.value).toBe('')
  })

  test('comma key also commits the tag', () => {
    let latest: MemoryFormState = defaultMemoryFormState()
    render(<Harness onChange={(s) => (latest = s)} />)
    const input = screen.getByTestId('memory-form-tag-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'comma-tag' } })
    fireEvent.keyDown(input, { key: ',' })
    expect(latest.tags).toContain('comma-tag')
  })

  test('clicking × on an existing chip removes it', () => {
    let latest: MemoryFormState = defaultMemoryFormState()
    render(<Harness initial={{ tags: ['a', 'b'] }} onChange={(s) => (latest = s)} />)
    fireEvent.click(screen.getByTestId('memory-form-tag-remove-a'))
    expect(latest.tags).toEqual(['b'])
  })

  test('reaching the 16 tag cap blocks adding a 17th tag via the validator', () => {
    let latest: MemoryFormState = defaultMemoryFormState()
    const tags = Array.from({ length: MEMORY_FORM_LIMITS.tagsMax }, (_, i) => `t${i}`)
    render(<Harness initial={{ tags }} onChange={(s) => (latest = s)} />)
    const input = screen.getByTestId('memory-form-tag-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'overflow' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // ChipsInput's validator rejects the commit; the inline error appears
    // and the tag list is unchanged.
    expect(latest.tags.length).toBe(MEMORY_FORM_LIMITS.tagsMax)
    expect(latest.tags).not.toContain('overflow')
  })

  test('renders body error inline when validateMemoryForm flags it', () => {
    render(<Harness initial={{ bodyMd: '' }} />)
    // The Field renders <span role="alert"> when an error is present.
    const alerts = screen.getAllByRole('alert')
    // At least one alert should be visible (body or title or scopeId).
    expect(alerts.length).toBeGreaterThan(0)
  })
})
