// RFC-304 T51 — the sample scripts are EXECUTED here, not just read.
//
// A sample that is only ever looked at is a sample that drifts: the schema gains
// a required field, every real script is updated, and the example a new team
// copies stays subtly wrong. So these run through the same `runMonitorScript`
// path production uses, and their output is validated against the same Zod
// schemas — which means this file fails the day a contract changes underneath
// them, which is the only time anyone would want to know.
//
// The classifier's behaviour on an unrecognised log is the case worth its own
// test. Emitting zero issues from a failing pipeline does not error anywhere:
// arbitration reads "nothing outstanding", the round becomes `noop`, and the
// merge request sits red while the platform reports it looked and found nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClassifiedIssuesSchema,
  CollectResultSchema,
} from '../src/modules/code-capability/domain/monitorContracts'
import {
  SAMPLE_MONITOR_SCRIPTS,
  SAMPLE_SCRIPT_LANGUAGE,
} from '../src/modules/code-capability/domain/sampleMonitorScripts'
import { runMonitorScript } from '../src/modules/code-capability/application/monitorScripts'
import type { MonitorScriptEnvironment } from '../src/modules/code-capability/application/monitorScripts'

const HEAD = 'a'.repeat(40)

describe('RFC-304 T51 — the sample collect/classify scripts', () => {
  let runDir: string

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'aw-rfc304-sample-'))
  })
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  const envOf = (): MonitorScriptEnvironment => ({
    worktreePath: runDir,
    runDir,
    repos: [{ name: 'main', path: runDir }],
    interpreterPath: 'node',
    workItem: {
      capability: 'ci-fix',
      anchorKind: 'mr',
      anchorId: '412',
      baselineSha: HEAD,
      roundId: 'round-1',
      roundSeq: 1,
    },
    envelopeNonce: 'samplenonce',
  })

  const classify = async (log: string) =>
    await runMonitorScript({
      definition: {
        name: 'classify',
        language: SAMPLE_SCRIPT_LANGUAGE,
        script: SAMPLE_MONITOR_SCRIPTS.classify.script,
      },
      schema: ClassifiedIssuesSchema,
      env: envOf(),
      input: { log },
    })

  test('the classifier reads a real tsc failure', async () => {
    // Exactly what this repository's own typecheck prints; a sample written
    // against an invented format teaches the wrong shape.
    const out = await classify(
      "src/retry.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    )

    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.value).toEqual([
      {
        type: 'compile',
        file: 'src/retry.ts',
        line: 12,
        message: "TS2322: Type 'string' is not assignable to type 'number'.",
        raw: "src/retry.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      },
    ])
  })

  test('the classifier reads a real bun test failure', async () => {
    const out = await classify('(fail) RFC-304 T53 — the structural signals > a removed [3.21ms]')

    expect(out.status).toBe('ok')
    const issues = out.status === 'ok' ? out.value : []
    expect(issues[0]?.type).toBe('unit-test')
    // The timing suffix is dropped: it changes on every run, and leaving it in
    // would give the same failing test a different fingerprint each time — the
    // quota would never engage.
    expect(issues[0]?.message).toBe('RFC-304 T53 — the structural signals > a removed')
  })

  test('the classifier reads a real eslint failure', async () => {
    const out = await classify("  12:5  error  'x' is defined but never used  no-unused-vars")

    expect(out.status).toBe('ok')
    const issues = out.status === 'ok' ? out.value : []
    expect(issues[0]?.type).toBe('codecheck')
    expect(issues[0]?.message).toContain('no-unused-vars')
  })

  test('a repeated compiler error becomes ONE issue', async () => {
    // Compilers re-report per import site. Forty identical prompts around one
    // problem is forty times the cost and no more information.
    const line = "src/a.ts(1,1): error TS2304: Cannot find name 'Foo'."
    const out = await classify([line, line, line].join('\n'))

    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.value.length).toBe(1)
  })

  test('an unrecognised failing log yields ONE item, never zero', async () => {
    // The quiet failure this guards: zero issues is a claim that the pipeline is
    // fine. Arbitration would read it as nothing outstanding, the round would
    // become `noop`, and the merge request would sit red while the platform
    // recorded that it looked.
    const out = await classify('Segmentation fault (core dumped)\nmake: *** [build] Error 139')

    expect(out.status).toBe('ok')
    const issues = out.status === 'ok' ? out.value : []
    expect(issues.length).toBe(1)
    expect(issues[0]?.type).toBe('unclassified')
    expect(issues[0]?.raw).toContain('Segmentation fault')
  })

  test('an empty log yields no issues — nothing failed', async () => {
    const out = await classify('')
    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.value).toEqual([])
  })

  test('collect refuses rather than guessing when no endpoint is configured', async () => {
    // A failed `collect` stops the round, which is right: there is nothing to
    // arbitrate against. The tempting alternative — treat it as an empty
    // collect — would arbitrate a merge request the platform never read.
    const out = await runMonitorScript({
      definition: {
        name: 'collect',
        language: SAMPLE_SCRIPT_LANGUAGE,
        script: SAMPLE_MONITOR_SCRIPTS.collect.script,
      },
      schema: CollectResultSchema,
      env: envOf(),
      input: { headSha: HEAD },
    })

    expect(out.status).toBe('blocked')
    expect(out.status === 'blocked' && out.reason).toContain('PIPELINE_API_BASE')
  })

  test('collect refuses an anchor that has no pipeline', async () => {
    // An issue-anchored work item has no pipeline. Reporting `pass` for it would
    // tell the monitor everything is fine about something the script never
    // looked at — the same shape as treating an unreachable pipeline as green,
    // and just as quiet.
    const out = await runMonitorScript({
      definition: {
        name: 'collect',
        language: SAMPLE_SCRIPT_LANGUAGE,
        script: SAMPLE_MONITOR_SCRIPTS.collect.script,
        env: { PIPELINE_API_BASE: 'http://127.0.0.1:1/nope', PIPELINE_PROJECT: 'p' },
      },
      schema: CollectResultSchema,
      env: {
        ...envOf(),
        workItem: { ...envOf().workItem, anchorKind: 'issue', anchorId: '77' },
      },
      input: { headSha: HEAD },
    })

    expect(out.status).toBe('blocked')
    expect(out.status === 'blocked' && out.reason).toContain('not issue')
  })

  test('collect reports an unreachable pipeline as a failure, never as `fail`', async () => {
    // The line that keeps a CI outage from becoming a repair storm: `fail` would
    // start a fix round on every open merge request at once, each pushing a
    // "fix" for a failure that never happened. The script exits non-zero
    // instead, and a blocked round says so.
    const out = await runMonitorScript({
      definition: {
        name: 'collect',
        language: SAMPLE_SCRIPT_LANGUAGE,
        script: SAMPLE_MONITOR_SCRIPTS.collect.script,
        // Where a department's own endpoint actually arrives: the author env
        // overlay on the script definition.
        env: { PIPELINE_API_BASE: 'http://127.0.0.1:1/nope' },
      },
      schema: CollectResultSchema,
      env: envOf(),
      input: { headSha: HEAD },
    })

    expect(out.status).toBe('blocked')
    expect(out.status === 'blocked' && out.reason).toContain('could not reach the pipeline')
  })
})
