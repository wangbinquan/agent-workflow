// RFC-359 Windows run 34170222964 observed an extra empty session-log entry
// after the expected designer first run and resume. The retained trace does
// not identify that third caller. Self-clarify does enqueue aw-memory-distiller,
// which inherits the same stub environment and starts without --session.
// Exercise that concrete shared-log mechanism through the real argv producer:
// scope the session oracle to the designer while retaining EVERY designer call.

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DISTILLER_AGENT_NAME } from '@/modules/memory/domain/distillPrompt'
import { buildCommand } from '@/services/runtime/opencode/spawn'

const STUB = resolve(import.meta.dir, '../../system-mocks/src/runtime/dispatch.ts')
const DESIGNER = 'e2e-rfc026-designer'
const PRIOR_SESSION = 'opc_e2e_e2e-rfc026-designer'
const PROMPT = 'Emit <workflow-output nonce="AWNONCE_rfc359_session_log">.'
const EXPECTED_DESIGNER_SESSIONS = ['', PRIOR_SESSION, '']
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(sessionAgent?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-inline-session-log-'))
  scratch.push(dir)
  const sessionLog = join(dir, 'session.log')
  const argvLog = join(dir, 'argv.log')
  const env = {
    ...process.env,
    AW_STUB_MODE: 'clarify-inline',
    CLARIFY_STUB_STATE: dir,
    CLARIFY_INLINE_ARGV_LOG: argvLog,
    CLARIFY_INLINE_SESSION_LOG: sessionLog,
    CLARIFY_INLINE_SESSION_AGENT: sessionAgent,
  }

  return {
    sessions: () => readFileSync(sessionLog, 'utf8').split('\n'),
    argv: () => readFileSync(argvLog, 'utf8').split('\n'),
    run(agentName: string, resumeSessionId?: string) {
      // defaultDistillerSpawn supplies DISTILLER_AGENT_NAME to this same argv
      // producer, with no resumeSessionId. Only the executable is replaced.
      const cmd = buildCommand(
        {
          agent: { name: agentName },
          opencodeCmd: [process.execPath, 'run', STUB],
          ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        },
        PROMPT,
      )
      const result = spawnSync(cmd[0]!, cmd.slice(1), {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      })
      expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({
        status: 0,
        error: undefined,
        stderr: '',
      })
      return { argv: cmd.slice(3).join(' '), stdout: result.stdout }
    },
  }
}

describe('RFC-359 inline session log records the selected designer across background calls', () => {
  test.each(['before first run', 'between rounds', 'after resume'] as const)(
    'keeps the exact two designer sessions with distiller %s',
    (when) => {
      const f = fixture(DESIGNER)
      const calls: string[] = []
      const distill = () => {
        const result = f.run(DISTILLER_AGENT_NAME)
        calls.push(result.argv)
        expect(result.stdout).toContain('"sessionID":"opc_e2e_aw-memory-distiller"')
      }

      if (when === 'before first run') distill()
      calls.push(f.run(DESIGNER).argv)
      if (when === 'between rounds') distill()
      calls.push(f.run(DESIGNER, PRIOR_SESSION).argv)
      if (when === 'after resume') distill()

      // Same exact split oracle as the E2E: keep the first empty session and
      // trailing newline, and neither filter nor deduplicate designer calls.
      expect(f.sessions()).toEqual(EXPECTED_DESIGNER_SESSIONS)
      // Background invocations still execute and remain in the diagnostic log.
      expect(f.argv()).toEqual([...calls, ''])
    },
  )

  test('retains an unexpected third designer call instead of hiding duplicate execution', () => {
    const f = fixture(DESIGNER)
    f.run(DESIGNER)
    f.run(DESIGNER, PRIOR_SESSION)
    expect(f.sessions()).toEqual(EXPECTED_DESIGNER_SESSIONS)

    f.run(DESIGNER)
    expect(f.sessions()).toEqual(['', PRIOR_SESSION, '', ''])
    expect(f.sessions()).not.toEqual(EXPECTED_DESIGNER_SESSIONS)
  })

  test.each([undefined, ''])('preserves the unscoped log when session agent is %s', (agent) => {
    const f = fixture(agent)
    f.run(DESIGNER)
    f.run(DESIGNER, PRIOR_SESSION)
    f.run(DISTILLER_AGENT_NAME)
    expect(f.sessions()).toEqual(['', PRIOR_SESSION, '', ''])
  })
})
