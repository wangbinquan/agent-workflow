// RFC-304 T47 — the framework's parameter table, and its one validator.
//
// "The interface and the API share one validation" is the requirement, which is
// why this lives in `shared` and why these tests are here rather than split
// across the two packages. Two validators drift, and the way that shows up is
// unpleasant: the form accepts a value, the API rejects it, and the person is
// told their input is invalid by a screen that just took it.
//
// The other theme is refusing to render what cannot be rendered honestly. An
// enum with no options is a dropdown with nothing in it; a duplicate name is
// two controls editing one value. Both are accepted by a permissive parser and
// both produce a form the author cannot debug.

import { describe, expect, test } from 'bun:test'
import {
  parseCapabilityParamTable,
  resolveCapabilityParams,
  validateCapabilityParams,
  type CapabilityParamTable,
} from '../src/capabilityParams'

const table = (fields: unknown[]): string => JSON.stringify(fields)

describe('RFC-304 T47 — reading a declared table', () => {
  test('a plain table parses', () => {
    const parsed = parseCapabilityParamTable(
      table([
        { name: 'triggerLabel', kind: 'string', required: true, label: 'Trigger label' },
        { name: 'maxAttempts', kind: 'number', min: 1, max: 10 },
        { name: 'strategy', kind: 'enum', options: ['fast', 'thorough'] },
      ]),
    )

    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.table.map((f) => f.name)).toEqual([
      'triggerLabel',
      'maxAttempts',
      'strategy',
    ])
    // `required` defaults to false, so an author who omits it gets the safer
    // reading rather than a form nobody can submit.
    expect(parsed.ok && parsed.table[1]?.required).toBe(false)
  })

  test('the column default `{}` means no parameters, not a broken table', () => {
    // That is literally what the database column defaults to.
    expect(parseCapabilityParamTable('{}')).toEqual({ ok: true, table: [] })
    expect(parseCapabilityParamTable('')).toEqual({ ok: true, table: [] })
  })

  test('malformed JSON is REPORTED, not silently empty', () => {
    // An empty table renders as a form with no fields, and the author concludes
    // the platform ignored their declaration rather than that it could not read
    // it.
    const parsed = parseCapabilityParamTable('{not json')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.issues[0]?.message).toContain('not valid JSON')
  })

  test('a non-empty object is reported rather than coerced', () => {
    expect(parseCapabilityParamTable('{"triggerLabel":"x"}').ok).toBe(false)
  })

  test('an enum with no options is refused', () => {
    // Otherwise it renders as a dropdown with nothing in it and no explanation.
    const parsed = parseCapabilityParamTable(table([{ name: 'strategy', kind: 'enum' }]))
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.issues[0]?.message).toContain('must list its options')
  })

  test('options on a non-enum field are refused', () => {
    const parsed = parseCapabilityParamTable(
      table([{ name: 'label', kind: 'string', options: ['a'] }]),
    )
    expect(parsed.ok).toBe(false)
  })

  test('min/max on a non-number field are refused', () => {
    expect(parseCapabilityParamTable(table([{ name: 'label', kind: 'string', min: 1 }])).ok).toBe(
      false,
    )
  })

  test('a max below its min is refused', () => {
    const parsed = parseCapabilityParamTable(
      table([{ name: 'n', kind: 'number', min: 10, max: 1 }]),
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.issues[0]?.message).toContain('below min')
  })

  test('two fields sharing a name are refused', () => {
    // The second silently wins in the params object, and the form shows two
    // controls editing one value.
    const parsed = parseCapabilityParamTable(
      table([
        { name: 'label', kind: 'string' },
        { name: 'label', kind: 'number' },
      ]),
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.issues[0]?.field).toBe('label')
  })

  test('a name that is not an identifier is refused', () => {
    // Scripts read these as env keys AND as object properties; a name with a
    // dot works in one and not the other, discovered at run time.
    expect(parseCapabilityParamTable(table([{ name: 'my.label', kind: 'string' }])).ok).toBe(false)
    expect(parseCapabilityParamTable(table([{ name: 'my label', kind: 'string' }])).ok).toBe(false)
    expect(parseCapabilityParamTable(table([{ name: '2fast', kind: 'string' }])).ok).toBe(false)
  })

  test('an unknown field kind is refused rather than rendered as text', () => {
    // An unrenderable field would become an invisible one, and an invisible
    // required field is a form nobody can submit.
    expect(parseCapabilityParamTable(table([{ name: 'x', kind: 'datetime' }])).ok).toBe(false)
  })
})

describe('RFC-304 T47 — validating submitted values', () => {
  const declared: CapabilityParamTable = [
    { name: 'triggerLabel', kind: 'string', required: true },
    { name: 'maxAttempts', kind: 'number', required: false, min: 1, max: 10 },
    { name: 'strict', kind: 'boolean', required: false },
    { name: 'strategy', kind: 'enum', required: false, options: ['fast', 'thorough'] },
    { name: 'paths', kind: 'string-list', required: false },
  ]

  test('a complete, correct set has no issues', () => {
    expect(
      validateCapabilityParams(declared, {
        triggerLabel: 'aw:implement',
        maxAttempts: 3,
        strict: true,
        strategy: 'fast',
        paths: ['src/', 'tests/'],
      }),
    ).toEqual([])
  })

  test('a missing required field is reported', () => {
    expect(validateCapabilityParams(declared, {})).toEqual([
      { field: 'triggerLabel', message: 'required' },
    ])
  })

  test('an empty string counts as absent', () => {
    // An HTML text input submits `''` for "I did not fill this in", and
    // treating that as a value would let a required field pass empty.
    expect(validateCapabilityParams(declared, { triggerLabel: '' })).toEqual([
      { field: 'triggerLabel', message: 'required' },
    ])
  })

  test('EVERY issue is reported, not just the first', () => {
    // One error at a time makes filling in five fields five round-trips.
    const issues = validateCapabilityParams(declared, {
      maxAttempts: 99,
      strategy: 'medium',
    })
    expect(issues.map((i) => i.field).sort()).toEqual(['maxAttempts', 'strategy', 'triggerLabel'])
  })

  test('a numeric STRING is accepted for a number field', () => {
    // The platform's own number input submits one; rejecting it would make the
    // form fail its own check.
    expect(validateCapabilityParams(declared, { triggerLabel: 'x', maxAttempts: '3' })).toEqual([])
  })

  test('a boolean is not a number', () => {
    // `Number(true)` is 1, so a naive coercion would accept it.
    const issues = validateCapabilityParams(declared, { triggerLabel: 'x', maxAttempts: true })
    expect(issues).toEqual([{ field: 'maxAttempts', message: 'must be a number' }])
  })

  test('range bounds are inclusive and reported with the bound', () => {
    expect(validateCapabilityParams(declared, { triggerLabel: 'x', maxAttempts: 1 })).toEqual([])
    expect(validateCapabilityParams(declared, { triggerLabel: 'x', maxAttempts: 10 })).toEqual([])
    expect(
      validateCapabilityParams(declared, { triggerLabel: 'x', maxAttempts: 0 })[0]?.message,
    ).toContain('at least 1')
  })

  test('an enum value outside the options lists what IS allowed', () => {
    const issues = validateCapabilityParams(declared, { triggerLabel: 'x', strategy: 'medium' })
    expect(issues[0]?.message).toContain('fast, thorough')
  })

  test('a list of non-strings is refused', () => {
    expect(
      validateCapabilityParams(declared, { triggerLabel: 'x', paths: ['ok', 7] })[0]?.field,
    ).toBe('paths')
  })

  test('`requireAll: false` checks types but not presence', () => {
    // What a binding's OVERRIDES need. A binding that overrides nothing is
    // legitimate — the framework's defaults may supply everything required —
    // and required-checking a partial set makes it impossible for a default to
    // satisfy a required field. That bug reported every unconfigured cell as
    // broken until this option existed.
    expect(validateCapabilityParams(declared, {}, { requireAll: false })).toEqual([])
    // …and it is still a validator: a wrong TYPE in the partial set is caught.
    expect(
      validateCapabilityParams(declared, { maxAttempts: 'lots' }, { requireAll: false }),
    ).toEqual([{ field: 'maxAttempts', message: 'must be a number' }])
  })

  test('required is enforced by DEFAULT — that is what a form needs', () => {
    expect(validateCapabilityParams(declared, {})).toEqual([
      { field: 'triggerLabel', message: 'required' },
    ])
  })

  test('an UNDECLARED key is reported, not dropped', () => {
    // Dropping it means an author who renamed a parameter keeps the old value
    // in the database and the new one unset, with the script reading neither.
    expect(validateCapabilityParams(declared, { triggerLabel: 'x', oldName: 'y' })).toEqual([
      { field: 'oldName', message: 'this framework declares no such parameter' },
    ])
  })
})

describe('RFC-304 T47 — defaults and overrides', () => {
  const declared: CapabilityParamTable = [
    { name: 'a', kind: 'string', required: false },
    { name: 'b', kind: 'string', required: false },
    { name: 'c', kind: 'number', required: false },
  ]

  test('a binding overriding ONE parameter keeps the others', () => {
    // Whole-object replacement blanks the rest, silently: the script simply
    // reads undefined and behaves as though nothing was configured.
    expect(
      resolveCapabilityParams(declared, { a: 'default-a', b: 'default-b', c: 1 }, { b: 'mine' }),
    ).toEqual({ a: 'default-a', b: 'mine', c: 1 })
  })

  test('an override may set a falsy value', () => {
    // `0` and `''` are real values. A truthiness check here would silently fall
    // back to the default for both.
    expect(resolveCapabilityParams(declared, { c: 5 }, { c: 0 })).toEqual({ c: 0 })
    expect(resolveCapabilityParams(declared, { a: 'x' }, { a: '' })).toEqual({ a: '' })
  })

  test('an undeclared default does not leak through', () => {
    // The table is the contract. A leftover default from a renamed parameter
    // would otherwise keep reaching the script.
    expect(resolveCapabilityParams(declared, { removed: 'x' }, {})).toEqual({})
  })

  test('an unset parameter is absent rather than null', () => {
    // A script checking `if (params.b)` and one checking `'b' in params` should
    // agree.
    const out = resolveCapabilityParams(declared, {}, { a: 'x' })
    expect(out).toEqual({ a: 'x' })
    expect('b' in out).toBe(false)
  })
})
