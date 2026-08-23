import { describe, expect, test } from 'bun:test'

import { matchRepoProvider } from '@/modules/integration/composition/codeHostEffects'

const LOCAL_GITLAB = {
  provider: 'gitlab' as const,
  baseUrl: 'http://127.0.0.1:8929/api/v4',
  repositoryUrlPrefixes: ['http://127.0.0.1:8929', 'http://aw-local-gitlab'],
}

describe('RFC-310 code-host repository binding', () => {
  test('matches an SSH URI with a custom port through the configured HTTP repository alias', () => {
    expect(
      matchRepoProvider(
        'ssh://git@aw-local-gitlab:2222/aw-local-bot/development-digital-employee-demo.git',
        [LOCAL_GITLAB],
      ),
    ).toEqual({
      provider: 'gitlab',
      project: 'aw-local-bot%2Fdevelopment-digital-employee-demo',
    })
  })

  test('matches an SCP-style SSH URL through the configured HTTP repository alias', () => {
    expect(matchRepoProvider('git@aw-local-gitlab:aw-local-bot/demo.git', [LOCAL_GITLAB])).toEqual({
      provider: 'gitlab',
      project: 'aw-local-bot%2Fdemo',
    })
  })

  test('keeps HTTP clone URLs fenced to the configured port', () => {
    expect(
      matchRepoProvider('http://127.0.0.1:8929/aw-local-bot/demo.git', [LOCAL_GITLAB]),
    ).toEqual({
      provider: 'gitlab',
      project: 'aw-local-bot%2Fdemo',
    })
    expect(
      matchRepoProvider('http://127.0.0.1:9999/aw-local-bot/demo.git', [LOCAL_GITLAB]),
    ).toBeNull()
  })
})
