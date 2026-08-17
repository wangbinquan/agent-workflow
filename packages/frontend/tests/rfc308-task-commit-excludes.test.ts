import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  taskCommitExcludePatternsAreValid,
  taskCommitExcludePatternsFromText,
  taskCommitExcludePatternsToText,
} from '../src/lib/task-commit-excludes'
import { SETTINGS_CONFIG_SCOPE_KEYS } from '../src/lib/settings-drafts'

describe('RFC-308 settings task commit excludes', () => {
  test('round-trips comments, commas, spaces, escapes, and ordering', () => {
    const text = '# note\nname,with,commas\nname with spaces\n\\#literal\n!keep.txt\n'
    const patterns = taskCommitExcludePatternsFromText(text)
    expect(patterns).toEqual([
      '# note',
      'name,with,commas',
      'name with spaces',
      '\\#literal',
      '!keep.txt',
    ])
    expect(taskCommitExcludePatternsToText(patterns)).toBe(text.trimEnd())
    expect(taskCommitExcludePatternsAreValid(patterns)).toBe(true)
  })

  test('drops only empty lines and rejects unsafe repository escapes', () => {
    expect(taskCommitExcludePatternsFromText('  \n\n../secret')).toEqual(['  ', '../secret'])
    expect(taskCommitExcludePatternsAreValid(['../secret'])).toBe(false)
  })

  test('Git settings owns and renders the concrete textarea entrypoint', () => {
    expect(SETTINGS_CONFIG_SCOPE_KEYS.git).toContain('taskCommitExcludePatterns')
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
      'utf8',
    )
    expect(source).toContain('data-testid="settings-task-commit-exclude-patterns"')
    expect(source).toContain('taskCommitExcludePatternsFromText')
  })
})
