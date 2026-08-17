// RFC-308 — one canonical in-repository platform workspace namespace.

import { describe, expect, test } from 'bun:test'
import {
  PLATFORM_FUSION_MANIFEST,
  PLATFORM_INPUTS_DIR,
  PLATFORM_RUNS_DIR,
  PLATFORM_WORKSPACE_DIR,
  isPlatformWorkspacePath,
  platformWorkspacePath,
  platformWorkspaceSegment,
} from '../src/workspaceConvention'

describe('RFC-308 platform workspace convention', () => {
  test('all generated paths live under .agent-workflow', () => {
    expect(PLATFORM_WORKSPACE_DIR).toBe('.agent-workflow')
    expect(PLATFORM_INPUTS_DIR).toBe('.agent-workflow/inputs')
    expect(PLATFORM_RUNS_DIR).toBe('.agent-workflow/runs')
    expect(PLATFORM_FUSION_MANIFEST).toBe('.agent-workflow/fusion/result.json')
    expect(platformWorkspacePath('runs', 'code-capability', 'round-1', 'collect')).toBe(
      '.agent-workflow/runs/code-capability/round-1/collect',
    )
  })

  test('rejects traversal, separators, drive prefixes and control characters', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'C:', 'x\n']) {
      expect(() => platformWorkspaceSegment(bad)).toThrow()
    }
  })

  test('normalizes NFC and recognizes only the canonical root', () => {
    expect(platformWorkspaceSegment('e\u0301')).toBe('é')
    expect(isPlatformWorkspacePath('.agent-workflow')).toBe(true)
    expect(isPlatformWorkspacePath('./.agent-workflow/inputs/a')).toBe(true)
    expect(isPlatformWorkspacePath('.agent-workflow-old/a')).toBe(false)
    expect(isPlatformWorkspacePath('.aw-run/a')).toBe(false)
  })
})
