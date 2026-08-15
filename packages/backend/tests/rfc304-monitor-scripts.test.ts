// RFC-304 T35/T35b — the four core monitor scripts, run for real.
//
// Real subprocesses, real envelopes, real python. A mocked runner would pass
// against a second copy of the execution machinery, which design D4 forbids —
// so these also serve as the evidence that `capabilityScriptRun` is genuinely
// the one implementation (`rfc304-hook-runner.test.ts` exercises the same code
// through the other caller).
//
// T35b is what most of this file is about, and it is a NEGATIVE property:
// nothing continues when a core script fails. The failure mode it guards is
// specific and quiet — "a failed collect is an empty collect" — which would
// arbitrate against a merge request the platform never read, conclude nothing
// is outstanding, and stay silent while a conflict sits there. Every way a
// script can fail to produce a usable result therefore gets its own case, and
// each asserts `blocked`, never a default value.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  runMonitorScript,
  type MonitorScriptDefinition,
  type MonitorScriptEnvironment,
} from '../src/modules/code-capability/application/monitorScripts'
import { CollectResultSchema } from '../src/modules/code-capability/domain/monitorContracts'

const NONCE = 'rfc304monitornonce'
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

/** Emit an envelope carrying `port` from a python literal expression. */
const emit = (port: string, jsonExpr: string): string =>
  [
    'import os, json',
    'n = os.environ["AW_ENVELOPE_NONCE"]',
    `body = ${jsonExpr}`,
    'print(f"<workflow-output nonce=\\"{n}\\">")',
    `print(f"<port name=\\"${port}\\">{body}</port>")`,
    'print("</workflow-output>")',
  ].join('\n')

const def = (over: Partial<MonitorScriptDefinition> = {}): MonitorScriptDefinition => ({
  name: 'collect',
  language: 'python',
  script: 'pass\n',
  ...over,
})

const GOOD_COLLECT = JSON.stringify({
  conflict: false,
  unresolvedComments: [],
  gate: { status: 'pass' },
  headSha: 'deadbeef',
})

describe('RFC-304 T35 — core monitor scripts', () => {
  let home: string
  let env: MonitorScriptEnvironment

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-monitor-'))
    env = {
      worktreePath: home,
      runDir: join(home, 'run'),
      repos: [{ name: 'main', path: home }],
      interpreterPath: PYTHON,
      workItem: {
        capability: 'mr-review',
        anchorKind: 'mr',
        anchorId: '412',
        roundId: 'R7',
        roundSeq: 3,
        baselineSha: 'abc123',
      },
      envelopeNonce: NONCE,
      timeoutMs: 30_000,
    }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('a well-formed collect result comes back parsed and typed', async () => {
    const out = await runMonitorScript({
      definition: def({
        script: emit('collect', `json.dumps(json.loads(r'''${GOOD_COLLECT}'''))`),
      }),
      schema: CollectResultSchema,
      env,
    })

    expect(out.status).toBe('ok')
    // Not just "it parsed" — the VALUE has to survive, because everything the
    // monitor decides afterwards is read off this object.
    expect(out.status === 'ok' && out.value.headSha).toBe('deadbeef')
    expect(out.status === 'ok' && out.value.gate.status).toBe('pass')
  })

  test('the script is told which script it is and which work item it serves', async () => {
    // `AW_CWI_SCRIPT` is how one adapter file can implement several steps, and
    // the rest is how an author debugging a failure knows which round ran it.
    const out = await runMonitorScript({
      definition: def({
        name: 'classify',
        script: [
          'import os, json',
          'n = os.environ["AW_ENVELOPE_NONCE"]',
          'body = json.dumps([{',
          '  "type": os.environ["AW_CWI_SCRIPT"],',
          '  "message": os.environ["AW_CWI_ANCHOR_ID"] + "/" + os.environ["AW_CWI_ROUND_ID"],',
          '}])',
          'print(f"<workflow-output nonce=\\"{n}\\">")',
          'print(f"<port name=\\"classify\\">{body}</port>")',
          'print("</workflow-output>")',
        ].join('\n'),
      }),
      schema: z.array(z.object({ type: z.string(), message: z.string() })),
      env,
    })

    expect(out.status === 'ok' && out.value[0]).toEqual({
      type: 'classify',
      message: '412/R7',
    })
  })

  const readsInputFile = [
    'import os, json',
    'n = os.environ["AW_ENVELOPE_NONCE"]',
    'raw = open(os.environ["AW_CWI_INPUT_FILE"], encoding="utf-8").read()',
    'parsed = json.loads(raw)',
    'body = json.dumps({"seen": parsed["headSha"], "count": len(parsed["unresolvedComments"])})',
    'print(f"<workflow-output nonce=\\"{n}\\">")',
    'print(f"<port name=\\"arbitrate\\">{body}</port>")',
    'print("</workflow-output>")',
  ].join('\n')

  const seenSchema = z.object({ seen: z.string(), count: z.number() })

  test('the previous step’s output reaches the script at AW_CWI_INPUT_FILE', async () => {
    const out = await runMonitorScript({
      definition: def({ name: 'arbitrate', script: readsInputFile }),
      schema: seenSchema,
      env,
      input: { headSha: 'cafef00d', unresolvedComments: [] },
    })

    expect(out.status === 'ok' && out.value.seen).toBe('cafef00d')
  })

  test('a LARGE input arrives by the same path — no size cliff for the adapter', async () => {
    // The regression this locks: the standard port protocol drops the inline
    // `AW_PORT_INPUT` above 32 KiB and spills to a file instead. An adapter
    // written against the inline variable would pass every test with a toy
    // merge request and then `KeyError` on the ones with the most comments —
    // exactly the merge requests the monitor exists for. `AW_CWI_INPUT_FILE` is
    // written unconditionally so there is one way to read the input, always.
    const bulky = {
      headSha: 'cafef00d',
      unresolvedComments: Array.from({ length: 400 }, (_, i) => ({
        threadId: `t${String(i)}`,
        author: 'reviewer',
        body: 'x'.repeat(200),
      })),
    }
    expect(JSON.stringify(bulky).length).toBeGreaterThan(32 * 1024)

    const out = await runMonitorScript({
      definition: def({ name: 'arbitrate', script: readsInputFile }),
      schema: seenSchema,
      env,
      input: bulky,
    })

    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.value.count).toBe(400)
  })
})

describe('RFC-304 T35b — a failed core script always blocks the round', () => {
  let home: string
  let env: MonitorScriptEnvironment

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-monitor-fail-'))
    env = {
      worktreePath: home,
      runDir: join(home, 'run'),
      repos: [{ name: 'main', path: home }],
      interpreterPath: PYTHON,
      workItem: {
        capability: 'mr-review',
        anchorKind: 'mr',
        anchorId: '9',
        roundId: 'R1',
        roundSeq: 1,
        baselineSha: null,
      },
      envelopeNonce: NONCE,
      timeoutMs: 30_000,
    }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('a non-zero exit blocks, and there is no `blocking` flag that could excuse it', async () => {
    // The contrast with a hook is the point: a hook that has not declared
    // `blocking` fails soft. A core script has no such field, because its
    // output is a required input rather than an optional opinion.
    const out = await runMonitorScript({
      definition: def({
        script: [
          'import sys',
          'print("upstream API said no", file=sys.stderr)',
          'sys.exit(3)',
        ].join('\n'),
      }),
      schema: CollectResultSchema,
      env,
    })

    expect(out.status).toBe('blocked')
    expect(out.status === 'blocked' && out.reason).toContain("'collect'")
    // The operator has to be able to act on this without opening a log file.
    expect(out.status === 'blocked' && out.reason).toContain('upstream API said no')
  })

  test('exit 0 with NO envelope blocks — it is not read as an empty collect', async () => {
    // This is the specific quiet failure T35b exists for. A script that dies
    // after printing a friendly message still exits 0 under `set +e`, and
    // treating that as `{conflict: false, comments: [], gate: pass}` would make
    // the platform confidently report a clean merge request it never read.
    const out = await runMonitorScript({
      definition: def({ script: 'print("nothing to do, boss")' }),
      schema: CollectResultSchema,
      env,
    })

    expect(out.status).toBe('blocked')
    expect(out.status === 'blocked' && out.reason).toContain('no')
    expect(out.status === 'blocked' && out.reason).toContain('collect')
  })

  test('an envelope with the WRONG nonce does not count as output', async () => {
    // Nonce scoping is what stops a script that merely quotes an envelope — in
    // a log line, a diff, a test fixture — from being read as having produced
    // one.
    const out = await runMonitorScript({
      definition: def({
        script: [
          `print('<workflow-output nonce="someone-elses-nonce">')`,
          `print('<port name="collect">${GOOD_COLLECT.replace(/"/g, '\\"')}</port>')`,
          `print('</workflow-output>')`,
        ].join('\n'),
      }),
      schema: CollectResultSchema,
      env,
    })

    expect(out.status).toBe('blocked')
  })

  test('output that is not JSON blocks', async () => {
    const out = await runMonitorScript({
      definition: def({
        script: [
          'import os',
          'n = os.environ["AW_ENVELOPE_NONCE"]',
          'print(f"<workflow-output nonce=\\"{n}\\">")',
          'print("<port name=\\"collect\\">conflict: no</port>")',
          'print("</workflow-output>")',
        ].join('\n'),
      }),
      schema: CollectResultSchema,
      env,
    })

    expect(out.status).toBe('blocked')
    expect(out.status === 'blocked' && out.reason).toContain('JSON')
  })

  test('JSON that violates the contract blocks, naming the field', async () => {
    // Well-formed JSON of the wrong shape is the likeliest real failure — an
    // adapter written against a slightly different host. The message names the
    // path so the author fixes the field instead of re-reading the whole
    // contract.
    const bad = JSON.stringify({
      conflict: false,
      unresolvedComments: [],
      gate: { status: 'green' }, // not one of pass/fail/running/unknown
      headSha: 'deadbeef',
    })
    const out = await runMonitorScript({
      definition: def({ script: emit('collect', `json.dumps(json.loads(r'''${bad}'''))`) }),
      schema: CollectResultSchema,
      env,
    })

    expect(out.status).toBe('blocked')
    expect(out.status === 'blocked' && out.reason).toContain('gate.status')
  })

  test('an UNKNOWN extra field blocks rather than being ignored', async () => {
    // `.strict()` on the contract, asserted through the runner: an adapter that
    // reports something the platform does not model should hear about it, not
    // have it silently dropped and then wonder why the monitor ignored it.
    const extra = JSON.stringify({
      conflict: false,
      unresolvedComments: [],
      gate: { status: 'pass' },
      headSha: 'deadbeef',
      approvals: 2,
    })
    const out = await runMonitorScript({
      definition: def({ script: emit('collect', `json.dumps(json.loads(r'''${extra}'''))`) }),
      schema: CollectResultSchema,
      env,
    })

    expect(out.status).toBe('blocked')
  })
})
