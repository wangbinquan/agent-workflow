// RFC-306 — locks the branch-activation judgment table (domain/branchActivation)
// and the envelope-level branch marker parsing (services/envelope).
//
// Why these two live in one file: they are the two halves of "did the author
// close this branch?" — the wire form and the graph rule. A regression in either
// half produces the same user-visible failure (a branch runs that should not, or
// vice versa), so they are reviewed together.
//
// Cases 4–7 of the marker suite come verbatim from the RFC-306 design gate
// (P2#11): a naive `\sactive\s*=` text search over the opening tag closes a
// branch when another attribute's VALUE happens to contain `active='false'`.
// Those four exist to keep the parser token-aware forever.

import { describe, expect, test } from 'bun:test'
import {
  edgeActivationOf,
  resolveNodeActivation,
  type EdgeActivation,
} from '../src/modules/task-execution/domain/branchActivation'
import { parseEnvelope, readPortActiveAttr } from '../src/services/envelope'
import { collectImplicitInboundRefs } from '../src/modules/task-execution/domain/inboundEdges'

const active: EdgeActivation = { kind: 'active' }
const inactive: EdgeActivation = { kind: 'inactive', reason: 'port-inactive' }
const skippedSource: EdgeActivation = { kind: 'inactive', reason: 'source-skipped' }
const unresolved: EdgeActivation = { kind: 'unresolved' }

describe('RFC-306 resolveNodeActivation — the judgment table', () => {
  test('no inbound edges ⇒ active (graph roots can never be branched away)', () => {
    expect(resolveNodeActivation({ inbound: [], joinMode: 'any' }).kind).toBe('active')
    expect(resolveNodeActivation({ inbound: [], joinMode: 'all' }).kind).toBe('active')
  })

  test("joinMode 'any': one live edge is enough", () => {
    expect(resolveNodeActivation({ inbound: [active, inactive], joinMode: 'any' }).kind).toBe(
      'active',
    )
  })

  test("joinMode 'any': ALL inbound inactive ⇒ skipped", () => {
    const got = resolveNodeActivation({ inbound: [inactive, skippedSource], joinMode: 'any' })
    expect(got).toEqual({ kind: 'skipped', reason: 'all-inbound-inactive' })
  })

  test("joinMode 'all': one inactive edge is enough to skip", () => {
    const got = resolveNodeActivation({ inbound: [active, inactive], joinMode: 'all' })
    expect(got).toEqual({ kind: 'skipped', reason: 'required-inbound-inactive' })
  })

  test("joinMode 'all': every edge live ⇒ active", () => {
    expect(resolveNodeActivation({ inbound: [active, active], joinMode: 'all' }).kind).toBe(
      'active',
    )
  })

  test('unresolved counts as live — a bookkeeping gap must not read as a decision', () => {
    // If this ever flips to "skipped", a momentarily unreadable upstream row
    // silently deletes real work instead of running it.
    expect(resolveNodeActivation({ inbound: [unresolved], joinMode: 'any' }).kind).toBe('active')
    expect(resolveNodeActivation({ inbound: [unresolved], joinMode: 'all' }).kind).toBe('active')
  })

  test('forceActivated overrides everything (RFC-306 §10 "run anyway")', () => {
    const got = resolveNodeActivation({
      inbound: [inactive, inactive],
      joinMode: 'all',
      forceActivated: true,
    })
    expect(got.kind).toBe('active')
  })
})

describe('RFC-306 edgeActivationOf — row/port → edge state', () => {
  test('no settled row ⇒ unresolved', () => {
    expect(edgeActivationOf({})).toEqual({ kind: 'unresolved' })
  })

  test('skipped source ⇒ inactive(source-skipped)', () => {
    expect(edgeActivationOf({ status: 'skipped' })).toEqual({
      kind: 'inactive',
      reason: 'source-skipped',
    })
  })

  test('done source, port marked inactive ⇒ inactive(port-inactive)', () => {
    expect(edgeActivationOf({ status: 'done', portActive: false })).toEqual({
      kind: 'inactive',
      reason: 'port-inactive',
    })
  })

  test('done source with NO port row ⇒ active (the back-compat hinge)', () => {
    // A port the producer never emitted has no row. Pre-RFC-306 that was "empty
    // string, keep going"; only an explicit marker may close a branch, so this
    // case must stay active or every existing workflow changes behavior.
    expect(edgeActivationOf({ status: 'done' })).toEqual({ kind: 'active' })
  })
})

describe('RFC-306 branch marker on the wire', () => {
  test('absent attribute ⇒ active (undefined, not false)', () => {
    expect(readPortActiveAttr('<port name="p">')).toBeUndefined()
  })

  test('active="false" / "true", both quote styles, case-insensitive', () => {
    expect(readPortActiveAttr('<port name="p" active="false">')).toBe(false)
    expect(readPortActiveAttr('<port name="p" active="FALSE">')).toBe(false)
    expect(readPortActiveAttr("<port name='p' active='true'>")).toBe(true)
    expect(readPortActiveAttr('<port name="p" active = "false" >')).toBe(false)
  })

  test('any other value is INVALID, never coerced', () => {
    // Guessing either way silently produces the wrong graph; the runner turns
    // this into a re-ask instead.
    expect(readPortActiveAttr('<port name="p" active="0">')).toBe('invalid')
    expect(readPortActiveAttr('<port name="p" active="no">')).toBe('invalid')
    expect(readPortActiveAttr('<port name="p" active="">')).toBe('invalid')
  })

  test('design-gate P2#11: `data-active` is a different attribute', () => {
    expect(readPortActiveAttr('<port name="p" data-active="false">')).toBeUndefined()
  })

  test("design-gate P2#11: `active='false'` INSIDE another attribute's value is text", () => {
    expect(readPortActiveAttr('<port name="p" note="x active=\'false\'">')).toBeUndefined()
    expect(readPortActiveAttr('<port name="p" note="active=\'false\'">')).toBeUndefined()
  })

  test('a real marker still parses when other attributes surround it', () => {
    expect(readPortActiveAttr('<port name="p" note="a" active="false" other="b">')).toBe(false)
  })
})

describe('RFC-306 parseEnvelope — inactive ports vs the existing signals', () => {
  const parse = (xml: string, declared: string[]) => parseEnvelope(xml, declared)

  test('marks the port inactive and keeps its text as the REASON', () => {
    const r = parse(
      '<workflow-output><port name="fix">do it</port><port name="ok" active="false">nothing to do</port></workflow-output>',
      ['fix', 'ok'],
    )
    expect(r.inactivePorts).toEqual(['ok'])
    expect(r.ports.get('ok')).toBe('nothing to do')
    expect(r.badActiveAttr).toEqual([])
  })

  test('an unmarked envelope reports NOTHING new (byte-compatible path)', () => {
    const r = parse('<workflow-output><port name="fix">x</port></workflow-output>', ['fix'])
    expect(r.inactivePorts).toEqual([])
    expect(r.badActiveAttr).toEqual([])
    expect(r.missingDeclared).toEqual([])
  })

  test('an invalid value lands in badActiveAttr, not in inactivePorts', () => {
    const r = parse('<workflow-output><port name="ok" active="0">x</port></workflow-output>', [
      'ok',
    ])
    expect(r.badActiveAttr).toEqual(['ok'])
    expect(r.inactivePorts).toEqual([])
  })

  test('duplicate port: the LAST emission wins for the marker too', () => {
    const r = parse(
      '<workflow-output><port name="ok" active="false">first</port><port name="ok">second</port></workflow-output>',
      ['ok'],
    )
    expect(r.ports.get('ok')).toBe('second')
    expect(r.inactivePorts).toEqual([])
  })

  test('a MALFORMED port is reported only as malformed — framing outranks the marker', () => {
    // Its close tag is corrupted, so nothing inside it (including the marker)
    // can be trusted; reporting a branch decision here would send the agent to
    // fix the wrong thing.
    const r = parse(
      '<workflow-output><port name="ok" active="false">x</|DSML|port></workflow-output>',
      ['ok'],
    )
    expect(r.malformedPorts).toEqual(['ok'])
    expect(r.inactivePorts).toEqual([])
  })

  test('absorption detection still fires for a port that carried a marker', () => {
    // `a`'s close is corrupted, so the scanner takes `b`'s clean `</port>` as
    // a's close and swallows b's opening tag into a's content. b is then a
    // DECLARED-but-missing port whose opening tag is still visible in the body —
    // the RFC-103 absorption signal. The RFC-306 change had to widen that
    // signal's regex to allow attributes, or a `b` carrying `active="false"`
    // would have read as "legitimately omitted" instead of "corrupted".
    const r = parse(
      '<workflow-output><port name="a">x</|DSML|port><port name="b" active="false">y</port></workflow-output>',
      ['a', 'b'],
    )
    expect(r.malformedPorts).toEqual(['b'])
    // …and the swallowed marker must NOT be reported as a branch decision.
    expect(r.inactivePorts).toEqual([])
  })

  test('prose that merely looks like an opening tag stays content', () => {
    // The attribute grammar is strict on purpose: widening it to `[^>]*` would
    // turn this sentence into a port boundary.
    const r = parse(
      '<workflow-output><port name="a">see <port name="b" and so on> here</port></workflow-output>',
      ['a'],
    )
    expect(r.ports.get('a')).toBe('see <port name="b" and so on> here')
    expect(r.malformedPorts).toEqual([])
  })
})

describe('RFC-306 implicit inbound refs (design-gate P1#2)', () => {
  test('review nodes expose inputSource as an inbound reference', () => {
    const refs = collectImplicitInboundRefs({
      kind: 'review',
      inputSource: { nodeId: 'a1', portName: 'doc' },
    })
    expect(refs).toEqual([{ nodeId: 'a1', portName: 'doc' }])
  })

  test('output nodes expose every ports[].bind', () => {
    const refs = collectImplicitInboundRefs({
      kind: 'output',
      ports: [
        { name: 'r', bind: { nodeId: 'a1', portName: 'fix' } },
        { name: 's', bind: { nodeId: 'a2', portName: 'ok' } },
      ],
    })
    expect(refs).toEqual([
      { nodeId: 'a1', portName: 'fix' },
      { nodeId: 'a2', portName: 'ok' },
    ])
  })

  test('agent / wrapper kinds expose none (their deps are real edges)', () => {
    expect(collectImplicitInboundRefs({ kind: 'agent-single' })).toEqual([])
    // A loop's exitCondition points INWARD; treating it as inbound would make a
    // wrapper skip itself exactly when its body closed a branch.
    expect(collectImplicitInboundRefs({ kind: 'wrapper-loop' })).toEqual([])
  })

  test('malformed shapes are ignored rather than throwing', () => {
    expect(collectImplicitInboundRefs({ kind: 'review', inputSource: null })).toEqual([])
    expect(collectImplicitInboundRefs({ kind: 'output', ports: 'nope' })).toEqual([])
    expect(collectImplicitInboundRefs({ kind: 'output', ports: [{ name: 'x' }] })).toEqual([])
  })
})
