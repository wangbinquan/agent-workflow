import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildVerifiedOpencodeSystemPlan } from '@/services/runtime/opencode/verifiedSystemPlan'
import {
  OFFICIAL_OPENCODE_BUILD_CODEC,
  type OfficialOpencodeBuild,
} from '@/services/runtime/opencode/officialBuilds'
import { VerifiedLaunchManifestSchema } from '@/services/runtime/opencode/verifiedManifest'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import { OPENCODE_FFF_CAPABILITY_CODEC } from '@/services/runtime/opencode/hermetic'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function root(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), 'rfc224-system-plan-'))
  roots.push(value)
  return value
}

const BUILD: Readonly<OfficialOpencodeBuild> = Object.freeze({
  platform: 'linux',
  arch: 'x64',
  version: '1.18.3',
  digest: 'fdf58364c969a144fff0ae3a30f2fb6e705ada06864842613de1f9ecc70feb20',
  codec: OFFICIAL_OPENCODE_BUILD_CODEC,
  fffCapabilityCodec: OPENCODE_FFF_CAPABILITY_CODEC,
})

describe('RFC-224 verified system plan', () => {
  test('fails closed before filesystem setup without enforce+bwrap', async () => {
    const base = root()
    const worktreePath = join(base, 'worktree')
    const runDir = join(base, 'run')
    await mkdir(worktreePath)

    let error: unknown
    try {
      await buildVerifiedOpencodeSystemPlan(
        {
          agentName: 'aw-system',
          systemPrompt: 'persona',
          model: 'openai/gpt-5',
          prompt: 'prompt',
          worktreePath,
          runDir,
        },
        ['/bin/echo'],
        {
          platform: 'linux',
          arch: 'x64',
          getSandbox: () => null,
        },
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ExecutionIdentityFailure)
    expect((error as ExecutionIdentityFailure).code).toBe('execution-identity-sandbox-required')
    expect(await stat(runDir).catch(() => null)).toBeNull()
  })

  test('builds one strict system manifest and hands cleanup ownership to the parent', async () => {
    const base = root()
    const worktreePath = join(base, 'worktree')
    const runDir = join(base, 'run')
    const appHome = join(base, 'app-home')
    await mkdir(worktreePath)

    const plan = await buildVerifiedOpencodeSystemPlan(
      {
        agentName: 'aw-system',
        systemPrompt: 'sealed persona',
        model: 'openai/gpt-5',
        prompt: 'exact prompt',
        worktreePath,
        runDir,
        appHome,
      },
      ['/official/opencode'],
      {
        platform: 'linux',
        arch: 'x64',
        getSandbox: () => ({
          mode: 'enforce',
          status: { mechanism: 'bwrap', available: true, detail: null },
          appHome,
        }),
        random: (size) => Buffer.alloc(size, 7),
        sourceEnv: { OPENAI_API_KEY: 'test-only-key' },
        requireBwrap: async () => '/usr/bin/bwrap',
        officialBuild: () => BUILD,
        snapshotBinary: async ({ snapshotPath }) => {
          await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
          await writeFile(snapshotPath, 'sealed official fixture', {
            flag: 'wx',
            mode: 0o500,
          })
          await chmod(snapshotPath, 0o500)
          return snapshotPath
        },
      },
    )

    expect(plan.control).toEqual({ kind: 'none' })
    expect(plan.sessionStore).toMatchObject({ persistent: false })
    expect(plan.env).toEqual({})
    expect(plan.cmd).toContain('__opencode-verified-run')
    const manifestPath = plan.cmd[plan.cmd.indexOf('--manifest') + 1]!
    const manifest = VerifiedLaunchManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    )
    expect(manifest).toMatchObject({
      storeKind: 'system-ephemeral',
      mode: 'new',
      selectedAgent: 'aw-system',
      selectedModel: { providerID: 'openai', modelID: 'gpt-5' },
      prompt: 'exact prompt',
      officialBuildDigest: BUILD.digest,
      fffCapabilityCodec: 1,
    })
    expect(manifest.fffProbe).toMatchObject({
      bwrapPath: '/usr/bin/bwrap',
      basename: `aw-fff-${'07'.repeat(16)}.txt`,
    })
    if (manifest.storeKind !== 'system-ephemeral') {
      throw new Error('expected system manifest')
    }
    const config = manifest.expectedConfig as Record<string, unknown>
    expect(config.plugin).toEqual([])
    expect(config.mcp).toEqual({})
    expect(config.shell).toBe('/bin/false')
    const agent = (config.agent as Record<string, Record<string, unknown>>)['aw-system']!
    expect(agent).toMatchObject({
      prompt: 'sealed persona',
      model: 'openai/gpt-5',
      mode: 'primary',
      hidden: false,
    })
    expect(agent.permission).toMatchObject({
      bash: 'deny',
      read: 'deny',
      edit: 'deny',
      write: 'deny',
      apply_patch: 'deny',
      grep: 'deny',
      glob: 'deny',
      skill: 'deny',
      task: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      lsp: 'deny',
    })
    expect(plan.readOnlySubtrees?.length).toBeGreaterThanOrEqual(4)

    await plan.cleanup?.()
    expect(await stat(manifestPath).catch(() => null)).toBeNull()
    expect(await stat(plan.sessionStore!.root).catch(() => null)).toBeNull()
  })
})
