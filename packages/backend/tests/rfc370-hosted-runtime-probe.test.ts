// RFC-370 hosted acceptance (2026-10-18) — a registered runtime probe on
// CrewStation names the platform profiles its smoke actually ran, and its smoke
// budget covers the platform container start.
//
// WHY THIS FILE EXISTS (regression intent): the first probe of `oc-glm` on the
// live platform failed with 409 `runtime-probe-stale` although nothing had
// changed the runtime. The hosted probe target hashes the platform's Agent
// profile capabilities; the target was captured from the copy read at the
// previous refresh, the smoke then refreshed it, and the receipt check compared
// the two. CrewStation resolves those profiles live, so any change by another
// project (a new compute revision, a re-tested capability) failed the next
// probe. The retry then failed as `model-call-failed: timed out after 60000ms`:
// the local smoke budget does not cover platform admission and the Agent
// container start of a hosted turn.
//
// 2026-10-19: a fixed 180 s turn budget, counted after ~43 s of workspace
// provisioning, still ended 3 s before a slow turn's successful result. The
// hosted probe now has one budget for the whole request and the turn gets
// what provisioning left (`rfc370-runtime-smoke-family` covers the core).
import { expect, test } from 'bun:test'
import {
  createCrewStationRuntimeManagementEffects,
  type HostedRuntimeCapabilities,
} from '@/modules/runtime-management/composition/crewstationRuntimeManagement'
import { composeRuntimeManagement } from '@/modules/runtime-management/composition/runtimeManagement'
import { HOSTED_RUNTIME_PROBE_BUDGET_MS } from '@/modules/task-execution/composition/crewstationRuntimeManagement'
import { DEFAULT_TIMEOUT_MS } from '@/modules/task-execution/application/runtimeSmoke'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { describeEachProvider } from './helpers/eachProvider'

const PROFILE = '01a13e6d-3e00-7000-9e3c-6a69d77164b3'
const COMPUTE = '01a13e6d-3e01-7000-ab4c-e0f049700850'

function capabilities(revision: number): HostedRuntimeCapabilities {
  return {
    protocolVersion: 3,
    releaseId: 'release',
    agentProfiles: [
      {
        agentProfileId: PROFILE,
        computeProfileId: COMPUTE,
        profileRevision: revision,
        capabilities: { events: true, mcp: true, usage: 'incremental' },
      },
    ],
  }
}

describeEachProvider('RFC-370 hosted runtime probe', (harness) => {
  test('a probe after a platform profile change caches the receipt instead of failing stale', async () => {
    const registry = composeRuntimeRegistryOperations(harness.db)
    await registry.seedBuiltinRuntimes()
    await registry.createRuntime({ name: 'oc-glm', protocol: 'opencode', model: 'vendor/model' })
    // The daemon read revision 2 at its last refresh; the platform now serves revision 3.
    let platform = capabilities(3)
    const smoked: number[] = []
    const management = composeRuntimeManagement({
      runtimeRegistry: registry,
      effects: createCrewStationRuntimeManagementEffects({
        profiles: [{ protocol: 'opencode', model: 'vendor/model', agentProfileId: PROFILE }],
        initialCapabilities: capabilities(2),
        capabilities: async () => platform,
        configuration: {
          current: async () => ({ defaultRuntime: 'opencode' }),
          withProbeReceiptFence: (action) => action(),
        },
        runtimeTests: { reconcileDurableIntents: async () => undefined },
        smoke: async () => {
          smoked.push(platform.agentProfiles[0]!.profileRevision)
          return {
            outcome: 'conforms',
            conforms: true,
            detail: 'fixture hosted turn',
            sawNonce: true,
            sawEnvelope: true,
            exitCode: 0,
          }
        },
      }),
    })

    const result = await management.runtimes.diagnostics.probe({
      kind: 'registered',
      name: 'oc-glm',
    })
    expect(result.smoke).toMatchObject({ outcome: 'conforms' })
    expect(smoked).toEqual([3])
    const listed = (await management.runtimes.queries.list()).runtimes.find(
      (row) => row.name === 'oc-glm',
    )
    expect(listed?.lastProbe).toMatchObject({ outcome: 'conforms' })

    // A platform change while the smoke runs, seen by a concurrent status
    // refresh, is still a stale receipt.
    const changing = createCrewStationRuntimeManagementEffects({
      profiles: [{ protocol: 'opencode', model: 'vendor/model', agentProfileId: PROFILE }],
      initialCapabilities: platform,
      capabilities: async () => platform,
      configuration: {
        current: async () => ({ defaultRuntime: 'opencode' }),
        withProbeReceiptFence: (action) => action(),
      },
      runtimeTests: { reconcileDurableIntents: async () => undefined },
      smoke: async (request) => {
        platform = capabilities(4)
        await changing.drivers.probeStatus(request.protocol, request.target, 1000)
        return {
          outcome: 'conforms',
          conforms: true,
          detail: 'fixture hosted turn',
          sawNonce: true,
          sawEnvelope: true,
          exitCode: 0,
        }
      },
    })
    const changed = composeRuntimeManagement({ runtimeRegistry: registry, effects: changing })
    await expect(
      changed.runtimes.diagnostics.probe({ kind: 'registered', name: 'oc-glm' }),
    ).rejects.toMatchObject({ code: 'runtime-probe-stale' })
  })
})

test('the hosted probe budget covers provisioning and a slow turn, within the HTTP idle timeout', () => {
  // The acceptance cluster's turn took 166 s after ~43 s of provisioning.
  expect(HOSTED_RUNTIME_PROBE_BUDGET_MS).toBeGreaterThanOrEqual(43_000 + 166_000 + 10_000)
  expect(HOSTED_RUNTIME_PROBE_BUDGET_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS)
  // cli/start.ts serves HTTP with `idleTimeout: 255`; the probe request waits for the smoke.
  expect(HOSTED_RUNTIME_PROBE_BUDGET_MS).toBeLessThan(255_000)
})

test('the hosted runtime management runs its smokes against the probe deadline', async () => {
  const source = await Bun.file(
    new URL(
      '../src/modules/task-execution/composition/crewstationRuntimeManagement.ts',
      import.meta.url,
    ),
  ).text()
  // One deadline for the whole probe request: the turn gets what provisioning left.
  expect(source).toContain('timeoutMs: HOSTED_RUNTIME_PROBE_BUDGET_MS,')
  expect(source).toContain('deadlineAt: Date.now() + HOSTED_RUNTIME_PROBE_BUDGET_MS,')
})
