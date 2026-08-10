import { describe, expect, test } from 'bun:test'
import {
  buildMcpReadinessPlan,
  compareMcpReadiness,
} from '@/services/runtime/opencode/mcpReadiness'

describe('RFC-272 MCP readiness', () => {
  test('builds the enabled, sorted, deduplicated manifest closure', () => {
    expect(
      buildMcpReadinessPlan([
        { name: 'remote-z', type: 'remote', enabled: true },
        { name: 'disabled', type: 'local', enabled: false },
        { name: 'local-a', type: 'local', enabled: true },
      ]),
    ).toEqual({
      enabled: true,
      servers: [
        { name: 'local-a', type: 'local' },
        { name: 'remote-z', type: 'remote' },
      ],
    })
    expect(() =>
      buildMcpReadinessPlan([
        { name: 'same', type: 'local', enabled: true },
        { name: 'same', type: 'remote', enabled: true },
      ]),
    ).toThrow('execution-identity-mismatch')
  })

  test('splits local failure from remote warning and ignores runtime extras', () => {
    expect(
      compareMcpReadiness(
        [
          { name: 'local-a', type: 'local' },
          { name: 'remote-b', type: 'remote' },
          { name: 'zero-tools', type: 'local' },
        ],
        {
          'local-a': 'failed',
          'remote-b': 'needs_auth',
          'zero-tools': 'connected',
          extra: 'connected',
        },
      ),
    ).toEqual({
      connected: [{ name: 'zero-tools', type: 'local', status: 'connected' }],
      unavailableLocal: [{ name: 'local-a', type: 'local', status: 'failed' }],
      unavailableRemote: [{ name: 'remote-b', type: 'remote', status: 'needs_auth' }],
    })
  })

  test('normalizes absent status to missing', () => {
    expect(compareMcpReadiness([{ name: 'gone', type: 'local' }], {})).toMatchObject({
      unavailableLocal: [{ name: 'gone', type: 'local', status: 'missing' }],
    })
  })
})
