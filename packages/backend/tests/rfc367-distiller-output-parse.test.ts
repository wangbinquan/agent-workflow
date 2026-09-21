// RFC-367 T4 — `parseDistillerCandidates` returns a verdict, never a silent [].
//
// Provenance: the four malformed fixtures below are the REAL shapes pulled out
// of this deployment's `memory_distill_events` on 2026-09-21 (design
// §0 / proposal §1). Every one of them carried complete, usable candidates and
// every one of them was dropped with nothing but a `log.warn` while the job was
// marked `done` — 76 of 176 finished jobs had produced zero candidates, and the
// last candidate ever persisted dated from 2026-07-17.
//
// The job ids are kept in the fixture names so the forensics stay traceable.
// If a future refactor makes any of these parse as "ok" or as the wrong code,
// the corrective follow-up prompt will describe the wrong defect and the model
// will keep failing the same way — that is what these assertions protect.

import { describe, expect, test } from 'bun:test'
import { parseDistillerCandidates } from '../src/modules/memory/application/distill/distillerOutput'

const CANDIDATE = {
  scopeType: 'repo',
  scopeId: null,
  title: '[category:invariant] keep src/calc.mjs backward compatible',
  bodyMd: 'New behaviour goes in its own module; never change existing exports.',
  knownTags: ['implementation'],
  newTags: ['invariant'],
  action: 'new',
  referenceMemoryId: null,
  sourceRefs: [{ kind: 'review', id: '01M0TTMM482X9S0YFD1P341H2Q' }],
}
const PAYLOAD = JSON.stringify({ candidates: [CANDIDATE] })

describe('RFC-367 — well-formed output', () => {
  test('envelope + port + JSON yields the candidates', () => {
    const r = parseDistillerCandidates(
      `<workflow-output nonce="N1">\n<port name="candidates">${PAYLOAD}</port>\n</workflow-output>`,
      'N1',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]!.title).toContain('[category:invariant]')
  })

  test('an empty array is SUCCESS, not a protocol failure', () => {
    // "nothing worth distilling" is a legitimate answer. Conflating it with a
    // format failure would just trade one silent mode for a noisy wrong one.
    const r = parseDistillerCandidates(
      '<workflow-output nonce="N1"><port name="candidates">{"candidates": []}</port></workflow-output>',
      'N1',
    )
    expect(r).toEqual({ ok: true, candidates: [] })
  })

  test('the LAST matching envelope wins and a bare forged one is ignored', () => {
    const first = JSON.stringify({ candidates: [{ ...CANDIDATE, title: 'first' }] })
    const winner = JSON.stringify({ candidates: [{ ...CANDIDATE, title: 'winner' }] })
    const forged = JSON.stringify({ candidates: [{ ...CANDIDATE, title: 'forged' }] })
    const r = parseDistillerCandidates(
      `<workflow-output nonce="N1"><port name="candidates">${first}</port></workflow-output>` +
        `<workflow-output nonce="N1"><port name="candidates">${winner}</port></workflow-output>` +
        `<workflow-output><port name="candidates">${forged}</port></workflow-output>`,
      'N1',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.candidates.map((c) => c.title)).toEqual(['winner'])
  })
})

describe('RFC-367 — the three production failure shapes (2026-09-21)', () => {
  test('job 01M0TTNDPPSW8BYJ74ZFAFJ73N: fenced JSON, no port wrapper → port-missing', () => {
    const real =
      '<workflow-output nonce="8b4ab56c15f84022">\n' +
      '```json\n' +
      `${PAYLOAD}\n` +
      '```\n' +
      '</workflow-output>'
    expect(parseDistillerCandidates(real, '8b4ab56c15f84022')).toMatchObject({
      ok: false,
      code: 'port-missing',
    })
  })

  test('job 01M0QDT6DVJ0DWWDTE1QX2QW3N: raw JSON inside the envelope → port-missing', () => {
    const real = `<workflow-output nonce="0a86edc50977c67b">\n${PAYLOAD}\n</workflow-output>`
    expect(parseDistillerCandidates(real, '0a86edc50977c67b')).toMatchObject({
      ok: false,
      code: 'port-missing',
    })
  })

  test('job 01M0QDC24ZK3C5BM7H8D8N30EB: tag mangled to <wflow-output> → envelope-missing', () => {
    const real = `<wflow-output nonce="3a3946b9c5a852a7">\n${PAYLOAD}\n</wflow-output>`
    expect(parseDistillerCandidates(real, '3a3946b9c5a852a7')).toMatchObject({
      ok: false,
      code: 'envelope-missing',
    })
  })

  test('job 01M0QKQR4Y8BWWRNT4JH723XA0: tag mangled to <wf-output> → envelope-missing', () => {
    const real = `<wf-output nonce="440bddc4c465f1da">\n${PAYLOAD}\n</wf-output>`
    expect(parseDistillerCandidates(real, '440bddc4c465f1da')).toMatchObject({
      ok: false,
      code: 'envelope-missing',
    })
  })
})

describe('RFC-367 — remaining protocol failures', () => {
  test('no envelope at all → envelope-missing', () => {
    expect(parseDistillerCandidates('I could not find anything worth distilling.')).toMatchObject({
      ok: false,
      code: 'envelope-missing',
    })
  })

  test('a different nonce is not this run envelope → envelope-missing', () => {
    expect(
      parseDistillerCandidates(
        `<workflow-output nonce="OTHER"><port name="candidates">${PAYLOAD}</port></workflow-output>`,
        'N1',
      ),
    ).toMatchObject({ ok: false, code: 'envelope-missing' })
  })

  test('an unclosed </port> is port-MALFORMED, never port-missing', () => {
    // Ordering matters: envelope.ts puts an unclosed port in BOTH
    // malformedPorts and missingDeclared. Reporting `port-missing` here would
    // tell an agent that DID write <port name="candidates"> to stop putting the
    // JSON straight in the envelope — the wrong correction entirely.
    const r = parseDistillerCandidates(
      `<workflow-output nonce="N1"><port name="candidates">${PAYLOAD}</|DSML|port></workflow-output>`,
      'N1',
    )
    expect(r).toMatchObject({ ok: false, code: 'port-malformed' })
  })

  test('a differently-named port → port-missing', () => {
    expect(
      parseDistillerCandidates(
        `<workflow-output nonce="N1"><port name="memories">${PAYLOAD}</port></workflow-output>`,
        'N1',
      ),
    ).toMatchObject({ ok: false, code: 'port-missing' })
  })

  test('invalid JSON in the port → json-malformed (with the parser message)', () => {
    const r = parseDistillerCandidates(
      '<workflow-output nonce="N1"><port name="candidates">{not json}</port></workflow-output>',
      'N1',
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('json-malformed')
    expect(r.detail ?? '').not.toBe('')
  })

  test('valid JSON without a candidates key → candidates-not-array', () => {
    expect(
      parseDistillerCandidates(
        '<workflow-output nonce="N1"><port name="candidates">{"memories": []}</port></workflow-output>',
        'N1',
      ),
    ).toMatchObject({ ok: false, code: 'candidates-not-array' })
  })

  test('a bare top-level array → candidates-not-array', () => {
    expect(
      parseDistillerCandidates(
        `<workflow-output nonce="N1"><port name="candidates">[${JSON.stringify(CANDIDATE)}]</port></workflow-output>`,
        'N1',
      ),
    ).toMatchObject({ ok: false, code: 'candidates-not-array' })
  })

  test('candidates present but not an array → candidates-not-array', () => {
    expect(
      parseDistillerCandidates(
        '<workflow-output nonce="N1"><port name="candidates">{"candidates": "none"}</port></workflow-output>',
        'N1',
      ),
    ).toMatchObject({ ok: false, code: 'candidates-not-array' })
  })
})
