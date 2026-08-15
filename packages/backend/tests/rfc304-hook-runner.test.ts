// RFC-304 T7 — capability hooks run as real subprocesses.
//
// No stubbing here: these spawn python, write the worktree, and parse a real
// envelope. That matters because the whole point of T7 was to REUSE the script
// node's execution machinery rather than grow a second one (design D4), and a
// mocked runner would pass just as happily against a copy.
//
// The three powers a hook has are each tested at their boundary, because each
// boundary is where a plausible-but-wrong implementation sits:
//   - inject: an unlisted key must be DROPPED, not merged. Free-form merge
//     would let a hook redefine any artifact the sequence depends on, and the
//     determinism claim would hold only until someone wrote a creative hook.
//   - abort: only a hook that DECLARED `blocking` may stop the round. A team's
//     optional lint hook going red must not strand an MR.
//   - side effects: the worktree is the shared medium; nothing mediates it.
//
// The version check is tested for what it does NOT do: a stale hook is neither
// run (it would be fed a shape it does not understand) nor silently skipped (a
// team's gate would quietly stop gating).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  injectableKeysFor,
  runCapabilityHook,
  type CapabilityHook,
  type HookRunEnvironment,
} from '../src/modules/code-capability/application/hookRunner'
import type { StageDef } from '../src/modules/code-capability/domain/stageContract'

const NONCE = 'rfc304hooknonce'

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

const stage = (over: Partial<StageDef> = {}): StageDef =>
  ({
    kind: 'program',
    name: 'review',
    requires: [],
    produces: [],
    ...over,
  }) as StageDef

const hook = (over: Partial<CapabilityHook> = {}): CapabilityHook => ({
  stage: 'review',
  phase: 'pre',
  language: 'python',
  script: 'pass\n',
  stageContractVer: 1,
  ...over,
})

describe('RFC-304 T7 — capability hook execution', () => {
  let home: string
  let env: HookRunEnvironment

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-hook-'))
    env = {
      worktreePath: home,
      runDir: join(home, 'run'),
      repos: [{ name: 'main', path: home }],
      interpreterPath: PYTHON,
      workItem: {
        capability: 'mr-review',
        anchorKind: 'mr',
        anchorId: '412',
        roundId: 'R1',
        roundSeq: 2,
        baselineSha: 'abc123',
      },
      envelopeNonce: NONCE,
      timeoutMs: 30_000,
    }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('a hook sees the work item through AW_CWI_* and can write the worktree', async () => {
    const out = await runCapabilityHook({
      hook: hook({
        script: [
          'import os',
          'with open(os.path.join(os.environ["AW_WORKTREE"], "hook-was-here.txt"), "w") as f:',
          '    f.write(os.environ["AW_CWI_CAPABILITY"] + "/" + os.environ["AW_CWI_ANCHOR_ID"]',
          '            + "@" + os.environ["AW_CWI_ROUND_SEQ"] + "/" + os.environ["AW_CWI_BASELINE_SHA"])',
        ].join('\n'),
      }),
      stage: stage(),
      env,
      currentStageContractVer: 1,
    })

    expect(out.status).toBe('ok')
    // Side effects are direct and unmediated — the worktree IS the medium.
    expect(readFileSync(join(home, 'hook-was-here.txt'), 'utf8')).toBe('mr-review/412@2/abc123')
  })

  test('the hook is told which stage and phase it is running in', async () => {
    await runCapabilityHook({
      hook: hook({
        phase: 'post',
        stage: 'publish',
        script: [
          'import os',
          'with open(os.path.join(os.environ["AW_WORKTREE"], "where.txt"), "w") as f:',
          '    f.write(os.environ["AW_CWI_STAGE"] + ":" + os.environ["AW_CWI_PHASE"])',
        ].join('\n'),
      }),
      stage: stage({ name: 'publish' }),
      env,
      currentStageContractVer: 1,
    })
    expect(readFileSync(join(home, 'where.txt'), 'utf8')).toBe('publish:post')
  })

  test('an allowlisted key is injected', async () => {
    const out = await runCapabilityHook({
      hook: hook({
        script: [
          'import os',
          'n = os.environ["AW_ENVELOPE_NONCE"]',
          'print(f"<workflow-output nonce=\\"{n}\\">")',
          'print("<port name=\\"promptSuffix\\">focus on error handling</port>")',
          'print("</workflow-output>")',
        ].join('\n'),
      }),
      stage: stage({ injectable: ['promptSuffix'] }),
      env,
      currentStageContractVer: 1,
    })

    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.injected).toEqual({
      promptSuffix: 'focus on error handling',
    })
  })

  test('an UNLISTED key is dropped, and the drop is reported rather than silent', async () => {
    // The boundary that matters: without the allowlist, a hook could redefine
    // `findings` or `diff` and quietly rewrite what the round is built on.
    const out = await runCapabilityHook({
      hook: hook({
        script: [
          'import os',
          'n = os.environ["AW_ENVELOPE_NONCE"]',
          'print(f"<workflow-output nonce=\\"{n}\\">")',
          'print("<port name=\\"findings\\">[]</port>")',
          'print("</workflow-output>")',
        ].join('\n'),
      }),
      stage: stage({ injectable: ['promptSuffix'] }),
      env,
      currentStageContractVer: 1,
    })

    expect(out.status).toBe('ok')
    expect(out.status === 'ok' && out.injected).toEqual({})
    // "My hook's output did nothing" is otherwise an unanswerable question.
    expect(out.status === 'ok' && out.droppedKeys).toContain('findings')
  })

  test('a stage with no injectable list accepts nothing', async () => {
    const out = await runCapabilityHook({
      hook: hook({
        script: [
          'import os',
          'n = os.environ["AW_ENVELOPE_NONCE"]',
          'print(f"<workflow-output nonce=\\"{n}\\"><port name=\\"promptSuffix\\">x</port></workflow-output>")',
        ].join('\n'),
      }),
      stage: stage(),
      env,
      currentStageContractVer: 1,
    })
    expect(out.status === 'ok' && out.injected).toEqual({})
  })

  test('a post hook cannot inject even where a pre hook could', async () => {
    // Injection feeds the stage that is about to run. After it has run there is
    // nothing left to feed, so accepting one would be a no-op that reads like a
    // feature.
    expect(injectableKeysFor(stage({ injectable: ['promptSuffix'] }), 'pre')).toEqual([
      'promptSuffix',
    ])
    expect(injectableKeysFor(stage({ injectable: ['promptSuffix'] }), 'post')).toEqual([])
  })

  test('ordinary stdout is not an injection', async () => {
    // Hooks always speak the envelope; otherwise every debug `print` would be
    // an injection attempt.
    const out = await runCapabilityHook({
      hook: hook({ script: 'print("promptSuffix: hello")\n' }),
      stage: stage({ injectable: ['promptSuffix'] }),
      env,
      currentStageContractVer: 1,
    })
    expect(out.status === 'ok' && out.injected).toEqual({})
  })

  test('a blocking hook that exits non-zero stops the round, carrying its stderr', async () => {
    const out = await runCapabilityHook({
      hook: hook({
        blocking: true,
        script:
          'import sys\nprint("policy: no reviews on release branches", file=sys.stderr)\nsys.exit(3)\n',
      }),
      stage: stage(),
      env,
      currentStageContractVer: 1,
    })
    expect(out.status).toBe('blocked')
    // The reason has to reach the round's record, or the MR shows a stop with
    // no cause.
    expect(out.status === 'blocked' && out.reason).toContain('release branches')
  })

  test('a NON-blocking hook that fails is recorded and does not stop the round', async () => {
    const out = await runCapabilityHook({
      hook: hook({ script: 'import sys\nsys.exit(1)\n' }),
      stage: stage(),
      env,
      currentStageContractVer: 1,
    })
    expect(out.status).toBe('failed-nonblocking')
  })

  test('blocking must be DECLARED — it is not inherited from failing', async () => {
    // Same script, two declarations, two outcomes. If blocking defaulted to
    // true, one team's optional lint hook would strand every MR.
    const script = 'import sys\nsys.exit(1)\n'
    const blocking = await runCapabilityHook({
      hook: hook({ script, blocking: true }),
      stage: stage(),
      env,
      currentStageContractVer: 1,
    })
    const optional = await runCapabilityHook({
      hook: hook({ script, blocking: false }),
      stage: stage(),
      env,
      currentStageContractVer: 1,
    })
    expect(blocking.status).toBe('blocked')
    expect(optional.status).toBe('failed-nonblocking')
  })

  test('a stale contract version is reported, and the hook never runs', async () => {
    const out = await runCapabilityHook({
      hook: hook({
        stageContractVer: 1,
        // If this ran, the file would exist.
        script:
          'import os\nopen(os.path.join(os.environ["AW_WORKTREE"], "ran.txt"), "w").close()\n',
      }),
      stage: stage(),
      env,
      currentStageContractVer: 2,
    })

    expect(out.status).toBe('needs-migration')
    expect(out.status === 'needs-migration' && out.declared).toBe(1)
    expect(out.status === 'needs-migration' && out.current).toBe(2)
    // Neither of the two wrong alternatives happened: it was not run…
    expect(existsSync(join(home, 'ran.txt'))).toBe(false)
    // …and it was not silently skipped (the caller gets a distinguishable
    // status, not `ok`).
    expect(out.status).not.toBe('ok')
  })

  test('the author env overlay applies, but cannot shadow the work-item context', async () => {
    const out = await runCapabilityHook({
      hook: hook({
        env: { TEAM_TOKEN: 'keep-me', AW_CWI_CAPABILITY: 'spoofed' },
        script: [
          'import os',
          'with open(os.path.join(os.environ["AW_WORKTREE"], "env.txt"), "w") as f:',
          '    f.write(os.environ.get("TEAM_TOKEN","") + "|" + os.environ["AW_CWI_CAPABILITY"])',
        ].join('\n'),
      }),
      stage: stage(),
      env,
      currentStageContractVer: 1,
    })
    expect(out.status).toBe('ok')
    // The author's own variable survives; the platform's context does not bend.
    expect(readFileSync(join(home, 'env.txt'), 'utf8')).toBe('keep-me|mr-review')
  })
})
