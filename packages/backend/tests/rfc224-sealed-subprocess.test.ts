import { describe, expect, test } from 'bun:test'
import {
  renderNetlessBwrapArgs,
  sanitizeNetlessEnvironment,
  type NetlessSubprocessManifest,
} from '@/services/runtime/opencode/sealedSubprocess'

function manifest(patch: Partial<NetlessSubprocessManifest> = {}): NetlessSubprocessManifest {
  return {
    codec: 1,
    mode: 'mcp',
    bwrapPath: '/usr/bin/bwrap',
    worktreePath: '/home/operator/worktree',
    scratchPath: '/srv/agent-workflow/runs/run-a/scratch',
    appHome: '/srv/agent-workflow',
    realHome: '/home/operator',
    bindReadOnly: [
      '/srv/agent-workflow/runs/run-a/seal/skills/skill-a',
      '/home/operator/bin/mcp-a',
    ],
    env: {
      HOME: '/srv/agent-workflow/stores/store-a/home',
      PATH: '/usr/bin:/bin',
    },
    command: ['/home/operator/bin/mcp-a', '--stdio'],
    ...patch,
  }
}

describe('RFC-224 sealed model-reachable subprocess boundary', () => {
  test('masks secret roots, unshares network/PIDs, and rebinds only the exact MCP executable', () => {
    const args = renderNetlessBwrapArgs(manifest(), [])
    expect(args).toContain('--unshare-net')
    expect(args).toContain('--unshare-pid')
    expect(args).toContain('--proc')

    const mounts: Array<[string, string, string]> = []
    for (let index = 0; index < args.length - 2; index += 1) {
      if (args[index] === '--ro-bind') {
        mounts.push([args[index]!, args[index + 1]!, args[index + 2]!])
      }
    }
    expect(mounts).toContainEqual([
      '--ro-bind',
      '/home/operator/bin/mcp-a',
      '/home/operator/bin/mcp-a',
    ])
    expect(mounts).not.toContainEqual(['--ro-bind', '/home/operator/bin', '/home/operator/bin'])
    expect(args).toContain('/srv/agent-workflow/runs/run-a/seal/skills/skill-a')
  })

  test('rejects a bind that can replace a secret mask or writable root', () => {
    for (const bindReadOnly of [
      ['/home'],
      ['/home/operator'],
      ['/srv'],
      ['/srv/agent-workflow'],
      ['/home/operator/worktree'],
      ['/srv/agent-workflow/runs/run-a'],
    ]) {
      expect(() => renderNetlessBwrapArgs(manifest({ bindReadOnly }), [])).toThrow(
        'execution-identity-store-unsafe',
      )
    }
  })

  test('rebuilds env and rejects loader, OpenCode, Git-exec, and shell-startup injection', () => {
    expect(
      sanitizeNetlessEnvironment({
        LANG: 'C.UTF-8',
        SAFE_TOKEN: 'allowed-by-explicit-MCP-policy',
        lower: 'ignored',
      }),
    ).toEqual({
      LANG: 'C.UTF-8',
      SAFE_TOKEN: 'allowed-by-explicit-MCP-policy',
    })
    for (const name of [
      'OPENCODE_SERVER_PASSWORD',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'BASH_ENV',
      'GIT_EXEC_PATH',
      'SSH_AUTH_SOCK',
    ]) {
      expect(() => sanitizeNetlessEnvironment({ [name]: 'secret' })).toThrow(
        'execution-identity-mismatch',
      )
    }
  })
})
