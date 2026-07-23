// RFC-224 T22 — verified inventory is launcher-authored metadata, never an
// executable plugin or `/mcp/status` result.

import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildVerifiedInventoryPlan,
  buildVerifiedInventorySnapshot,
  writeVerifiedInventorySnapshot,
} from '@/services/runtime/opencode/verifiedInventory'
import { opencodeDriver } from '@/services/runtime/opencode/driver'

const roots: string[] = []
const originalPure = process.env.OPENCODE_PURE

afterEach(async () => {
  if (originalPure === undefined) delete process.env.OPENCODE_PURE
  else process.env.OPENCODE_PURE = originalPure
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RFC-224 verified inventory provenance', () => {
  test('uses verified agents, a distinct built-in baseline, frozen skills, manifest MCPs, and no plugins', () => {
    const plan = buildVerifiedInventoryPlan({
      enabled: true,
      frozenSkills: [
        {
          name: 'review-code',
          skillId: 'skill-review',
          treeDigest: 'a'.repeat(64),
        },
      ],
      mcps: [
        { name: 'docs', type: 'remote', enabled: true },
        { name: 'local-tools', type: 'local', enabled: true },
        { name: 'disabled', type: 'local', enabled: false },
      ],
    })
    if (!plan.enabled) throw new Error('fixture must enable inventory')

    const snapshot = buildVerifiedInventorySnapshot({
      agents: [
        {
          name: 'worker',
          mode: 'primary',
          native: false,
          model: { providerID: 'openai', modelID: 'gpt-5.6' },
        },
        {
          name: 'build',
          mode: 'primary',
          native: true,
          model: null,
        },
      ],
      plan,
      capturedAt: 123,
    })

    expect(snapshot.agents).toEqual([
      {
        name: 'build',
        mode: 'primary',
        modelProviderId: null,
        modelId: null,
        source: 'runtime-native',
      },
      {
        name: 'worker',
        mode: 'primary',
        modelProviderId: 'openai',
        modelId: 'gpt-5.6',
        source: 'manifest-controlled',
      },
    ])
    expect(snapshot.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'customize-opencode',
          source: 'runtime-baseline',
          path: '<built-in>',
        }),
        {
          name: 'review-code',
          source: 'prompt-injected-frozen',
          path: null,
          description: null,
        },
      ]),
    )
    expect(snapshot.mcps).toEqual([
      { name: 'docs', type: 'remote', status: 'configured', hint: null },
      { name: 'local-tools', type: 'local', status: 'configured', hint: null },
    ])
    expect(snapshot.plugins).toEqual([])
  })

  test('writes one private exclusive inventory file and rejects replacement', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'rfc224-inventory-'))
    roots.push(runRoot)
    const plan = buildVerifiedInventoryPlan({
      enabled: true,
      frozenSkills: [],
      mcps: [],
    })
    if (!plan.enabled) throw new Error('fixture must enable inventory')
    const snapshot = buildVerifiedInventorySnapshot({
      agents: [{ name: 'worker', mode: 'primary', native: false, model: null }],
      plan,
      capturedAt: 456,
    })

    await writeVerifiedInventorySnapshot(runRoot, snapshot)
    const path = join(runRoot, 'inventory.json')
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(snapshot)
    await expect(writeVerifiedInventorySnapshot(runRoot, snapshot)).rejects.toMatchObject({
      code: 'execution-identity-store-unsafe',
    })
  })

  test('runner readback accepts launcher-authored inventory under the pure child profile', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'rfc224-inventory-read-'))
    roots.push(runRoot)
    const plan = buildVerifiedInventoryPlan({
      enabled: true,
      frozenSkills: [],
      mcps: [],
    })
    if (!plan.enabled) throw new Error('fixture must enable inventory')
    const snapshot = buildVerifiedInventorySnapshot({
      agents: [{ name: 'worker', mode: 'primary', native: false, model: null }],
      plan,
      capturedAt: 789,
    })
    await writeVerifiedInventorySnapshot(runRoot, snapshot)
    process.env.OPENCODE_PURE = '1'

    await expect(
      opencodeDriver.readInventory?.({
        runRoot,
        nodeKind: 'agent-single',
        verifiedIdentity: true,
      }),
    ).resolves.toEqual(snapshot)
    await expect(
      opencodeDriver.readInventory?.({
        runRoot,
        nodeKind: 'agent-single',
        verifiedIdentity: false,
      }),
    ).resolves.toMatchObject({ captured: false, reason: 'opencode-pure-mode' })
  })
})
