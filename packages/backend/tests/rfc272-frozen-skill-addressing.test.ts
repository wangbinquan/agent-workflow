import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { buildControlledOpencodeConfig } from '@/services/runtime/opencode/hermetic'
import { renderFrozenSkillBlock } from '@/services/runtime/opencode/verifiedPlan'
import { businessOpencodeIdentityDigestV3 } from '@/services/runtime/opencode/executionIdentity'
import { SEALED_SHELL_SUPPORTED } from '@/util/platformExec'

const skillId = 'skill-reference-fixture'
const sealName = createHash('sha256').update(skillId).digest('hex').slice(0, 24)
const treeDigest = 'a'.repeat(64)

function fixture(runName: string, entries = ['SKILL.md', 'examples/', 'reference.md']) {
  const runRoot = resolve(tmpdir(), runName)
  const sealRoot = join(runRoot, 'opencode-identity-seal')
  const target = join(sealRoot, 'skills', sealName)
  const prompt = renderFrozenSkillBlock({
    name: 'probe',
    digest: treeDigest,
    root: target,
    entries: entries.map((path) =>
      path.endsWith('/')
        ? { path: path.slice(0, -1), type: 'directory' as const }
        : { path, type: 'file' as const },
    ),
    markdown: 'Read reference.md before answering.',
  })
  const config = buildControlledOpencodeConfig({
    name: 'worker',
    prompt,
    description: 'worker',
    model: 'openai/gpt-5.6',
    toolOutputPattern: join(resolve(tmpdir(), 'aw-rfc272-store'), 'tool-output', '*'),
    shellPath: SEALED_SHELL_SUPPORTED ? join(sealRoot, 'shell', 'sh') : null,
    allowShell: false,
    mcp: {},
    readOnlyExternalDirectories: [target],
  })
  return { runRoot, sealRoot, target, prompt, config }
}

describe('RFC-272 frozen skill addressing', () => {
  test('renders the authoritative root and deterministic JSON-lines file list', () => {
    const built = fixture('aw-rfc272-render')
    expect(built.prompt).toContain(`root=${JSON.stringify(built.target)}`)
    expect(built.prompt).toContain('fileCount=3 filesTruncated=false')
    expect(built.prompt).toContain('"SKILL.md"\n"examples/"\n"reference.md"')
  })

  test('opens read-only tools for the selected root while retaining the external deny', () => {
    const built = fixture('aw-rfc272-permission')
    const permission = (
      built.config.agent as unknown as Record<string, { permission: Record<string, unknown> }>
    ).worker!.permission
    expect(permission.read).toBe('allow')
    expect(permission.grep).toBe('allow')
    expect(permission.glob).toBe('allow')
    expect(permission.external_directory).toMatchObject({
      '*': 'deny',
      [`${built.target}/*`]: 'allow',
    })
    expect(permission.write).toBe('deny')
    expect(permission.edit).toBe('deny')
  })

  test('normalizes only the attempt root while retaining the tree/file identity', () => {
    const first = fixture('aw-rfc272-run-a')
    const resumed = fixture('aw-rfc272-run-b')
    const digest = (built: ReturnType<typeof fixture>) =>
      businessOpencodeIdentityDigestV3({
        config: built.config,
        agent: 'worker',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
        binaryDigest: 'b'.repeat(64),
        sealRoot: built.sealRoot,
        frozenSkills: [{ name: 'probe', skillId, sealName, treeDigest, target: built.target }],
      })
    expect(digest(first)).toBe(digest(resumed))
    expect(digest(fixture('aw-rfc272-run-c', ['SKILL.md', 'changed.md']))).not.toBe(digest(first))
  })
})
