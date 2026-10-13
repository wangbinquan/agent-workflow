// RFC-370: only an already-ready selected resource session can survive blocked
// execution startup. Native and resource-initialization failures still surface.
import { expect, test } from 'bun:test'
import { resumeDaemonResourcesForServing } from '../src/cli/daemonHostExecutionBootstrap'

test.each(['native', 'resource-not-ready', 'closed-host', 'unrelated-failure'] as const)(
  'serving does not hide %s startup failure',
  async (kind) => {
    const error = new Error('original startup failure')
    let warnings = 0
    const session = {
      async resume() {
        throw error
      },
      state: () => ({
        phase: kind === 'resource-not-ready' ? ('frozen' as const) : ('running' as const),
        activeHandleIds: [],
      }),
    }
    const host =
      kind === 'native'
        ? undefined
        : {
            queries: {
              snapshot: () => ({
                phase: kind === 'closed-host' ? ('closed' as const) : ('draining' as const),
                generation: 'original-generation',
                readyGroups: [],
                reason:
                  kind === 'unrelated-failure'
                    ? 'other-resource-error'
                    : 'host-execution-start-failed',
              }),
            },
          }
    await expect(
      resumeDaemonResourcesForServing({
        session,
        scope: { provider: 'sqlite', generationId: 'original-generation', operationId: 'startup' },
        host,
        onExecutionUnavailable: () => {
          warnings += 1
        },
      }),
    ).rejects.toBe(error)
    expect(warnings).toBe(0)
  },
)
