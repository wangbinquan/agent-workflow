import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { applyConfigPatch, saveConfigRaw } from '../src/config'
import { readCommitExcludePatterns } from '../src/services/scheduler'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-308 operation config projection', () => {
  test('a saved rule applies to the next operation, while one read stays immutable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc308-config-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    saveConfigRaw(configPath, { ...DEFAULT_CONFIG, taskCommitExcludePatterns: ['first/**'] })
    const opts = {
      taskId: 'task',
      appHome: root,
      configPath,
      commitPushExcludePatterns: ['launch-fallback/**'],
    }

    const first = await readCommitExcludePatterns(opts)
    applyConfigPatch(configPath, { taskCommitExcludePatterns: ['second/**'] })
    expect(first).toEqual(['first/**'])
    expect(await readCommitExcludePatterns(opts)).toEqual(['second/**'])

    writeFileSync(configPath, '{broken json')
    expect(await readCommitExcludePatterns(opts)).toEqual(['launch-fallback/**'])
  })
})
