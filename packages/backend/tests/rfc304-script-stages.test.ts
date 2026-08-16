// RFC-304 — the `script` stage kind, which the round engine could not run.
//
// The engine dispatched `program`, `ai` and `invoke`, and answered `script`
// with `notImplemented`. Only `CI_FIX_CONTRACT` declares script stages — its
// first FOUR — so every `ci-fix` round died at stage zero with "is kind
// 'script', which has no runner registered yet", in every deployment.
//
// Nothing about it was undecided, which is what makes it the same finding as
// the rest of plan §2ter rather than missing design work: the four slots are
// exactly the framework's script slots, `runMonitorScript` already runs those
// same four for the monitor loop, and the result schemas already existed and
// map one-to-one onto what each stage produces. Four built pieces, no join.
//
// The scripts are executed for real here (python subprocesses through the
// production runner), because the thing worth locking is that a framework
// author's script actually reaches the round and its output actually becomes
// the stage's artifact. A faked runner would assert the shape of a call rather
// than the fact of one.

import { describe, expect, test } from 'bun:test'
import { buildScriptStages } from '../src/modules/code-capability/composition/scriptStages'
import { CI_FIX_CONTRACT } from '../src/modules/code-capability/domain/capabilityRegistry'
import type { MonitorScriptSet } from '../src/modules/code-capability/application/monitorLoop'
import type { MonitorScriptEnvironment } from '../src/modules/code-capability/application/monitorScripts'
import type { StageRunContext } from '../src/modules/code-capability/application/stageEngine'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NONCE = 'nonce-script-stage'

/** A python script emitting `port` with the given JSON body, verbatim. */
const emits = (port: string, value: unknown) => ({
  name: port as 'collect',
  language: 'python' as const,
  script: [
    'import os, json',
    'n = os.environ["AW_ENVELOPE_NONCE"]',
    `body = json.dumps(json.loads(r'''${JSON.stringify(value)}'''))`,
    'print(f"<workflow-output nonce=\\"{n}\\">")',
    `print(f"<port name=\\"${port}\\">{body}</port>")`,
    'print("</workflow-output>")',
  ].join('\n'),
})

/** Echoes what the framework was handed as input, so the wiring is observable. */
const echoesInput = (port: string) => ({
  name: port as 'collect',
  language: 'python' as const,
  script: [
    'import os, json',
    'n = os.environ["AW_ENVELOPE_NONCE"]',
    'raw = open(os.environ["AW_CWI_INPUT_FILE"]).read() if os.environ.get("AW_CWI_INPUT_FILE") else "{}"',
    'seen = json.loads(raw)',
    // Reports what it received THROUGH the contract's own shape, so the
    // assertion reads the real artifact rather than a side channel.
    'out = [{"type": "echo", "message": json.dumps(sorted(seen.keys()))}]',
    'print(f"<workflow-output nonce=\\"{n}\\">")',
    `print("<port name=\\"${port}\\">" + json.dumps(out) + "</port>")`,
    'print("</workflow-output>")',
  ].join('\n'),
})

const envFor = (): ((stageName: string) => MonitorScriptEnvironment) => {
  const root = mkdtempSync(join(tmpdir(), 'aw-script-stage-'))
  return (stageName: string) => ({
    worktreePath: root,
    runDir: join(root, 'run', stageName),
    repos: [],
    interpreterPath: 'python3',
    workItem: {
      capability: 'ci-fix',
      anchorKind: 'mr',
      anchorId: '412',
      roundId: 'round-1',
      roundSeq: 1,
      baselineSha: null,
    },
    envelopeNonce: NONCE,
    timeoutMs: 20_000,
  })
}

const ctx = (artifacts: Record<string, unknown> = {}): StageRunContext =>
  ({
    roundId: 'round-1',
    stage: { kind: 'program', name: 'x', requires: [], produces: [] },
    artifacts,
  }) as unknown as StageRunContext

describe('RFC-304 — script stages run the framework’s scripts', () => {
  test('every script stage of the contract gets an implementation', () => {
    // Derived from the CONTRACT, so a script stage added later is implemented
    // automatically instead of reintroducing "no runner registered" — the
    // failure this whole file exists to end.
    const stages = buildScriptStages(CI_FIX_CONTRACT, {
      scripts: { collect: emits('collect', {}) } as MonitorScriptSet,
      makeEnv: envFor(),
    })
    const declared = CI_FIX_CONTRACT.stages
      .filter((s) => s.kind === 'script')
      .map((s) => s.name)
      .sort()

    expect(declared).toEqual(['arbitrate', 'classify', 'collect', 'select'])
    expect(Object.keys(stages).sort()).toEqual(declared)
  })

  test('a script’s output becomes the stage’s artifact', async () => {
    // The join, end to end: a framework author's script runs as a real
    // subprocess and what it emitted is what the next stage will read.
    const collected = {
      conflict: false,
      unresolvedComments: [],
      gate: { status: 'fail' },
      headSha: 'sha-aaa',
    }
    const stages = buildScriptStages(CI_FIX_CONTRACT, {
      scripts: { collect: emits('collect', collected) } as MonitorScriptSet,
      makeEnv: envFor(),
    })

    const result = await stages['collect']!(ctx())
    expect(result.status).toBe('done')
    expect(result.status === 'done' && result.produced).toEqual({ gateState: collected })
  })

  test('a MISSING script refuses by name, and says which layer owns it', async () => {
    // Not "unregistered". A framework author needs to know the slot; a group
    // lead needs to know the fix is not theirs to make, because scripts live on
    // the department layer behind `scripts:author`.
    const stages = buildScriptStages(CI_FIX_CONTRACT, {
      scripts: { collect: emits('collect', {}) } as MonitorScriptSet,
      makeEnv: envFor(),
    })

    const result = await stages['classify']!(ctx({ gateState: {} }))
    expect(result.status).toBe('failed')
    const error = result.status === 'failed' ? result.error : ''
    expect(error).toContain("'classify'")
    expect(error).toContain('scripts:author')
  })

  test('a script whose output breaks its contract FAILS the stage', async () => {
    // The determinism guarantee. `classify` must produce a list of issues; a
    // script returning something else has to stop the round, because every
    // later stage — and the agent prompt — is built from this artifact.
    const stages = buildScriptStages(CI_FIX_CONTRACT, {
      scripts: {
        collect: emits('collect', {}),
        classify: emits('classify', { not: 'a list' }),
      } as MonitorScriptSet,
      makeEnv: envFor(),
    })

    const result = await stages['classify']!(ctx({ gateState: {} }))
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.error).toContain('classify')
  })

  test('a stage receives exactly its declared `requires`, nothing more', async () => {
    // Contract discipline rather than convenience: handing over the whole
    // artifact bag would let a script depend on something its contract never
    // promised, and that dependency breaks the first time stage order changes.
    const stages = buildScriptStages(CI_FIX_CONTRACT, {
      scripts: {
        collect: emits('collect', {}),
        classify: echoesInput('classify'),
      } as MonitorScriptSet,
      makeEnv: envFor(),
    })

    const result = await stages['classify']!(
      ctx({ gateState: { a: 1 }, somethingElse: { b: 2 }, worktree: { c: 3 } }),
    )
    expect(result.status).toBe('done')
    const produced = result.status === 'done' ? result.produced : undefined
    const issues = (produced?.['issues'] ?? []) as Array<{ message: string }>
    // `classify` requires ONLY `gateState`.
    expect(JSON.parse(issues[0]?.message ?? '[]')).toEqual(['gateState'])
  })
})
