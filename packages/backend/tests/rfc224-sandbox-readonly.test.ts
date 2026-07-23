// RFC-224 T9 — immutable runtime seals must be overlaid read-only after the
// enclosing runDir RW bind. These tests lock mount ordering and reject paths
// that could broaden or escape the per-run allow scope.

import { describe, expect, test } from 'bun:test'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
} from '../src/services/sandbox/policy'

const APP_HOME = '/srv/agent-workflow'
const RUN_DIR = `${APP_HOME}/runs/task-1/run-1`
const SEAL = `${RUN_DIR}/identity-seal`

function policy(readOnlySubtrees: readonly string[] = [SEAL]) {
  return computeSandboxPolicy({
    appHome: APP_HOME,
    taskWorktrees: [`${APP_HOME}/worktrees/repo/task-1`],
    runDir: RUN_DIR,
    readOnlySubtrees,
  })
}

describe('RFC-224 sandbox readOnlySubtrees', () => {
  test('bwrap stacks every RO overlay after all RW allow-backs', () => {
    const args = renderBwrapArgs(policy(), { appHome: APP_HOME })
    const lastRwBind = args.lastIndexOf('--bind')
    const roBind = args.indexOf('--ro-bind')
    expect(roBind).toBeGreaterThan(lastRwBind)
    expect(args.slice(roBind, roBind + 3)).toEqual(['--ro-bind', SEAL, SEAL])
  })

  test('Seatbelt revokes write after RW allow-back while preserving read', () => {
    const lines = renderSeatbeltProfile(policy()).split('\n')
    const rw = lines.indexOf(`(allow file-read* file-write* (subpath "${RUN_DIR}"))`)
    const denyWrite = lines.indexOf(`(deny file-write* (subpath "${SEAL}"))`)
    const allowRead = lines.indexOf(`(allow file-read* (subpath "${SEAL}"))`)
    expect(rw).toBeGreaterThan(-1)
    expect(denyWrite).toBeGreaterThan(rw)
    expect(allowRead).toBeGreaterThan(denyWrite)
  })

  test('accepts distinct seals under a task worktree or the run directory', () => {
    const worktreeSeal = `${APP_HOME}/worktrees/repo/task-1/.aw-seal`
    expect(policy([SEAL, worktreeSeal]).readOnlySubtrees).toEqual([SEAL, worktreeSeal])
  })

  test.each([
    ['relative', 'relative/seal'],
    ['non-normalized', `${RUN_DIR}/nested/../seal`],
    ['NUL', `${RUN_DIR}/seal\0tail`],
    ['outside all allowed roots', `${APP_HOME}/backups`],
    ['same as runDir', RUN_DIR],
    ['filesystem root', '/'],
  ])('rejects %s read-only paths', (_label, path) => {
    expect(() => policy([path])).toThrow(TypeError)
  })

  test('rejects duplicate overlays instead of relying on ambiguous mount order', () => {
    expect(() => policy([SEAL, SEAL])).toThrow(TypeError)
  })
})
