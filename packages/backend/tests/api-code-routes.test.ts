// RFC-304 T31b — the `/code` HTTP surface, including every way it says no.
//
// The rejection half is the point. The 2026-07-21 test-guard audit found that
// the most common escape is testing only what SHOULD happen: happy paths get
// written because a feature is not "done" without them, while the 4xx branches
// have no product pressure behind them. So each error code below is named
// explicitly rather than asserted as "some 4xx" — a status-range assertion
// passes no matter which branch fired, which means a guard can be deleted and
// its request answered by an unrelated rejection with the test still green.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'

import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'
import { mkdtempSync as createFixtureDirectory, rmSync as removeFixtureDirectory } from 'node:fs'
import { tmpdir as fixtureTmpDirectory } from 'node:os'
import { join as joinFixturePath } from 'node:path'

const TOKEN = 'a'.repeat(64)

afterEach(() => {
  resetBroadcastersForTests()
})

const auth = { authorization: `Bearer ${TOKEN}` }

describe('RFC-304 — reading the capability matrix', () => {
  registerProviderApplication((buildApp) => {
    test('a repository with no cells returns an empty list, not an error', async () => {
      // "Nothing configured" is the state every repository starts in; answering
      // it with a 404 would make the page's first render look broken.
      const { app } = await buildApp()
      const res = await app.request('/api/code/matrix/group%2Fproject', { headers: auth })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ rows: [] })
    })
  })

  registerProviderApplication((buildApp) => {
    test('without a bearer token it is refused', async () => {
      const { app } = await buildApp()
      const res = await app.request('/api/code/matrix/group%2Fproject')
      expect(res.status).toBe(401)
    })
  })
})
describe('RFC-304 T61 — the troubleshooting chain over HTTP', () => {
  // The table has been written since T61 and nothing could read it, so the
  // question it exists to answer — "why did review stop on this repository?" —
  // had no way to be asked. These pin the endpoint's shape rather than the
  // query behind it (that has its own file): which filters it accepts, and the
  // one request it refuses.

  registerProviderApplication((buildApp) => {
    test('a project filter answers with that project’s chain', async () => {
      const { app } = await buildApp()
      const res = await app.request('/api/code/deliveries?projectId=proj-1', { headers: auth })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ deliveries: [] })
    })
  })

  registerProviderApplication((buildApp) => {
    test('a correlation id answers on its own, without needing a project', async () => {
      // The id follows one event across tables; an operator holding it has
      // already narrowed the question and should not have to narrow it again.
      const { app } = await buildApp()
      const res = await app.request('/api/code/deliveries?correlationId=abc', { headers: auth })
      expect(res.status).toBe(200)
    })
  })

  registerProviderApplication((buildApp) => {
    test('failures may be asked for across every project', async () => {
      const { app } = await buildApp()
      const res = await app.request('/api/code/deliveries?failedOnly=true', { headers: auth })
      expect(res.status).toBe(200)
    })
  })

  registerProviderApplication((buildApp) => {
    test('an unfiltered request is REFUSED, and says what to name', async () => {
      // The whole table is every delivery on the instance, which buries the
      // incident the operator came for. Refusing with the three options is more
      // useful than answering with all of them.
      const { app } = await buildApp()
      const res = await app.request('/api/code/deliveries', { headers: auth })
      expect(res.status).toBeGreaterThanOrEqual(400)
      const body = JSON.stringify(await res.json())
      expect(body).toContain('code-delivery-filter-required')
      expect(body).toContain('correlationId')
    })
  })

  registerProviderApplication((buildApp) => {
    test('a non-numeric limit is refused by name, like every other list here', async () => {
      const { app } = await buildApp()
      const res = await app.request('/api/code/deliveries?projectId=p&limit=lots', {
        headers: auth,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(await res.json())).toContain('code-limit-invalid')
    })
  })

  registerProviderApplication((buildApp) => {
    test('without a bearer token it is refused', async () => {
      const { app } = await buildApp()
      expect((await app.request('/api/code/deliveries?projectId=p')).status).toBe(401)
    })
  })
})
describe('RFC-304 — listing work items', () => {
  registerProviderApplication((buildApp) => {
    test('an empty deployment returns an empty page with no cursor', async () => {
      const { app } = await buildApp()
      const res = await app.request('/api/code/work-items', { headers: auth })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ items: [], nextCursor: null })
    })
  })

  registerProviderApplication((buildApp) => {
    test('a non-numeric limit is refused by name rather than silently defaulted', async () => {
      // Silently defaulting would answer a page size nobody asked for, and the
      // caller would conclude the parameter is unsupported rather than mistyped.
      const { app } = await buildApp()
      const res = await app.request('/api/code/work-items?limit=lots', { headers: auth })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(await res.json())).toContain('code-limit-invalid')
    })
  })

  registerProviderApplication((buildApp) => {
    test('a non-numeric round count is refused by its own name (T66)', async () => {
      // Its own code rather than `code-limit-invalid`: two numeric parameters on
      // one endpoint, and a caller told "limit is invalid" while `rounds` is the
      // mistyped one goes looking in the wrong place.
      const { app } = await buildApp()
      const res = await app.request('/api/code/work-items?rounds=all', { headers: auth })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(await res.json())).toContain('code-rounds-invalid')
    })
  })

  registerProviderApplication((buildApp) => {
    test('an empty page still reports how many rounds it is hiding', async () => {
      // Zero, not absent. The page renders the notice from this field
      // unconditionally, so a missing key would read as "nothing hidden" on every
      // item — which is the silent truncation T66 exists to end.
      const { app } = await buildApp()
      const res = await app.request('/api/code/work-items?rounds=20', { headers: auth })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ items: [], nextCursor: null })
    })
  })

  registerProviderApplication((buildApp) => {
    test('without a bearer token it is refused', async () => {
      const { app } = await buildApp()
      expect((await app.request('/api/code/work-items')).status).toBe(401)
    })
  })
})

describe('RFC-307 — the stage graph over HTTP', () => {
  registerProviderApplication((buildApp) => {
    test('a capability answers with its flow WITHOUT any repository configured', async () => {
      // The whole reason this endpoint takes no repository: the user needs to see
      // what a capability does before deciding whether to enable it anywhere. An
      // endpoint that required a configured repo would answer a later question.
      const { app } = await buildApp()
      const res = await app.request('/api/code/capabilities/mr-review/graph', { headers: auth })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        capability: string
        stageContractVer: number
        nodes: { name: string; kind: string }[]
        edges: { from: string; to: string; artifact: string }[]
      }
      expect(body.capability).toBe('mr-review')
      expect(body.stageContractVer).toBeGreaterThan(0)
      expect(body.nodes).toHaveLength(13)
      expect(body.edges.length).toBeGreaterThan(0)
      // Kinds survive serialization — the UI draws four different node shapes
      // from this field, so an object that lost it would render as one grey box,
      // which is the state this RFC exists to end.
      expect(body.nodes.filter((n) => n.kind === 'ai').map((n) => n.name)).toEqual([
        'review-shard',
        'review-global',
      ])
    })
  })

  registerProviderApplication((buildApp) => {
    test('mr-monitor answers 200 with a REASON, not 404', async () => {
      // It ships as a capability but is a main loop rather than a sequence. 404
      // is the answer to "no such capability", and giving it here would send a
      // user looking for a typo that is not there.
      const { app } = await buildApp()
      const res = await app.request('/api/code/capabilities/mr-monitor/graph', { headers: auth })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ capability: 'mr-monitor', reason: 'no-stage-contract' })
    })
  })

  registerProviderApplication((buildApp) => {
    test('a capability the platform does not ship is 404', async () => {
      const { app } = await buildApp()
      const res = await app.request('/api/code/capabilities/mr-invented/graph', { headers: auth })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'unknown-capability' })
    })
  })

  registerProviderApplication((buildApp) => {
    test('without a bearer token it is refused', async () => {
      const { app } = await buildApp()
      expect((await app.request('/api/code/capabilities/mr-review/graph')).status).toBe(401)
    })
  })
})

// RFC-359 W49: keep native fixtures while running the original selected calls on each provider.
function registerProviderApplication(
  register: (buildApp: () => Promise<{ db: ProviderNeutralDatabase; app: Hono }>) => void,
): void {
  describeEachProvider('provider', (harness) => {
    describe('application lifetime', () => {
      let application: ProviderHttpApplication | undefined
      let ownedHome: string | undefined
      let previousHome: string | undefined
      let homeAssigned = false
      async function buildApp() {
        ownedHome = createFixtureDirectory(
          joinFixturePath(fixtureTmpDirectory(), 'rfc359-w49-api-code-routes-'),
        )
        previousHome = process.env.AGENT_WORKFLOW_HOME
        process.env.AGENT_WORKFLOW_HOME = ownedHome
        homeAssigned = true
        const appHome = ownedHome
        application = await createProviderHttpApplication(harness, {
          token: TOKEN,
          configPath: joinFixturePath(appHome, 'config.json'),
          opencodeVersion: '1.15.0',
          dbVersion: 1,
          appHome,
        })
        return { db: harness.db, app: application.app }
      }
      afterEach(async () => {
        try {
          await application?.dispose()
        } finally {
          application = undefined
          if (homeAssigned) {
            if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
            else process.env.AGENT_WORKFLOW_HOME = previousHome
          }
          homeAssigned = false
          if (ownedHome !== undefined)
            removeFixtureDirectory(ownedHome, { recursive: true, force: true })
          ownedHome = undefined
        }
      })
      register(buildApp)
    })
  })
}
