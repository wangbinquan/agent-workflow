// RFC-308 — one canonical in-repository platform workspace namespace.

import { describe, expect, test } from 'bun:test'
import {
  PLATFORM_FUSION_MANIFEST,
  PLATFORM_INPUTS_DIR,
  PLATFORM_PIPELINE_DIR,
  PLATFORM_REQUIREMENTS_DIR,
  PLATFORM_RUNS_DIR,
  PLATFORM_WORKSPACE_DIR,
  isPlatformWorkspacePath,
  pipelineBundlePath,
  platformWorkspacePath,
  platformWorkspaceSegment,
  requirementBundlePath,
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

  // RFC-310 T32 —— pipeline 子目录与 requirement/pipeline bundle helper。
  // 两个 bundle 根都在 .agent-workflow 下 ⇒ RFC-308 的整目录 exclude 规则
  // （workspaceExcludeProfile 的 gitignoreDirectoryRule(PLATFORM_WORKSPACE_DIR)）
  // 自动覆盖，无需新增排除项。
  test('rfc310: pipeline kind and bundle path helpers stay inside the platform dir', () => {
    expect(PLATFORM_PIPELINE_DIR).toBe('.agent-workflow/pipeline')
    expect(PLATFORM_REQUIREMENTS_DIR).toBe('.agent-workflow/inputs/requirements')
    expect(requirementBundlePath('01BUNDLE')).toBe('.agent-workflow/inputs/requirements/01BUNDLE')
    expect(requirementBundlePath('01BUNDLE', 'manifest.json')).toBe(
      '.agent-workflow/inputs/requirements/01BUNDLE/manifest.json',
    )
    expect(pipelineBundlePath('01PIPE', 'logs', 'compile.log')).toBe(
      '.agent-workflow/pipeline/01PIPE/logs/compile.log',
    )
    expect(() => requirementBundlePath('../escape')).toThrow()
    expect(() => pipelineBundlePath('ok', 'a/b')).toThrow()
    expect(isPlatformWorkspacePath(pipelineBundlePath('01PIPE'))).toBe(true)
    expect(platformWorkspacePath('pipeline', '01PIPE')).toBe('.agent-workflow/pipeline/01PIPE')
  })
})
