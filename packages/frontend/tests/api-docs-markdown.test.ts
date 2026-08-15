// RFC-247 D17 / AC-22 / AC-27 — the wiki body.
//
// The page is built from the daemon's generated payload, so the front end's
// half of the derivation lock is: feed it a payload with something extra and
// the body must gain it. A page that hard-coded any of this would pass a
// snapshot test and still be wrong the moment a route changed.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildApiDocsMarkdown,
  type ApiDocsPayload,
  type ApiDocsStrings,
} from '@/lib/api-docs-markdown'

const STRINGS: ApiDocsStrings = {
  intro: 'INTRO',
  quickStart: 'QUICKSTART',
  quickStartBody: 'QUICKSTART_BODY',
  connecting: 'CONNECTING',
  toolsHeading: 'TOOLS',
  toolsIntro: 'TOOLS_INTRO',
  restHeading: 'REST',
  restIntro: 'REST_INTRO',
  permissionsHeading: 'PERMISSIONS',
  permissionsIntro: 'PERMISSIONS_INTRO',
  alwaysGrantedHeading: 'ALWAYS',
  alwaysGrantedIntro: 'ALWAYS_INTRO',
  resourcesHeading: 'RESOURCES',
  resourcesIntro: 'RESOURCES_INTRO',
  colTool: 'Tool',
  colNeeds: 'Requires',
  colDescription: 'Description',
  colMethod: 'Method',
  colPath: 'Path',
  colSummary: 'Summary',
  colOperation: 'Operation',
  colPermission: 'Permission',
  needsNothing: 'NOTHING',
  notAvailableToYou: 'UNAVAILABLE',
}

function payload(overrides: Partial<ApiDocsPayload> = {}): ApiDocsPayload {
  return {
    role: 'admin',
    grantablePermissions: [
      {
        resource: 'agents',
        verbs: [
          { verb: 'create', permission: 'agents:create' },
          { verb: 'delete', permission: 'agents:delete' },
        ],
      },
    ],
    alwaysGranted: ['agents:read', 'tasks:read'],
    endpoints: [
      {
        method: 'GET',
        path: '/api/agents',
        summary: 'List agents',
        permissions: ['agents:read'],
        open: false,
      },
    ],
    tools: [
      {
        name: 'launch_task',
        title: 'Launch a task',
        description: 'Start a workflow run.',
        permissions: ['tasks:execute'],
        grantable: true,
      },
    ],
    resourceKinds: [
      {
        kind: 'agents',
        operations: [
          { operation: 'list', method: 'GET', path: '/api/agents', permission: null },
          { operation: 'create', method: 'POST', path: '/api/agents', permission: 'agents:create' },
        ],
      },
    ],
    mcp: { endpoint: '/api/mcp', transport: 'Streamable HTTP', auth: 'Bearer <token>' },
    snippets: [{ id: 'curl', label: 'curl', language: 'bash', code: 'curl example' }],
    ...overrides,
  }
}

describe('RFC-247 AC-22 — the page body is derived from the payload', () => {
  test('a tool that is not in the payload is not in the body', () => {
    const body = buildApiDocsMarkdown(payload(), STRINGS)
    expect(body).toContain('launch_task')
    expect(body).not.toContain('cancel_task')
  })

  test('adding a tool to the payload adds it to the body', () => {
    const body = buildApiDocsMarkdown(
      payload({
        tools: [
          ...payload().tools,
          {
            name: 'a_brand_new_tool',
            title: 'New',
            description: 'Did not exist a moment ago.',
            permissions: ['workflows:create'],
            grantable: true,
          },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('a_brand_new_tool')
    expect(body).toContain('workflows:create')
  })

  test('an endpoint’s declared permission is what the body prints', () => {
    const body = buildApiDocsMarkdown(
      payload({
        endpoints: [
          {
            method: 'DELETE',
            path: '/api/workflows/:id',
            summary: 'Delete a workflow',
            permissions: ['workflows:delete'],
            open: false,
          },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('`workflows:delete`')
    expect(body).toContain('/api/workflows/:id')
  })
})

describe('RFC-247 — the body states requirements honestly', () => {
  test('an open endpoint says so rather than showing an empty cell', () => {
    const body = buildApiDocsMarkdown(
      payload({
        endpoints: [
          { method: 'GET', path: '/api/whoami', summary: 'Who am I', permissions: [], open: true },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('NOTHING')
  })

  test('every capability requirement is shown as an explicit permission', () => {
    const body = buildApiDocsMarkdown(
      payload({
        endpoints: [
          {
            method: 'POST',
            path: '/api/memory-distill-jobs/:id/retry',
            summary: 'Retry',
            permissions: ['memory:update', 'tasks:execute', 'memory-distill-jobs:manage'],
            open: false,
          },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('`memory:update`')
    expect(body).toContain('`tasks:execute`')
    expect(body).toContain('`memory-distill-jobs:manage`')
  })

  test('a tool the role cannot use is listed AND marked', () => {
    const body = buildApiDocsMarkdown(
      payload({
        tools: [
          {
            name: 'delete_task',
            title: 'Delete',
            description: 'Irreversible.',
            permissions: ['tasks:delete'],
            grantable: false,
          },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('delete_task')
    expect(body).toContain('UNAVAILABLE')
  })

  test('a resource note is rendered above its table', () => {
    const body = buildApiDocsMarkdown(
      payload({
        resourceKinds: [
          {
            kind: 'repos',
            operations: [
              { operation: 'list', method: 'GET', path: '/api/cached-repos', permission: null },
            ],
            note: 'Repos are imported in batches.',
          },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('> Repos are imported in batches.')
    expect(body.indexOf('Repos are imported in batches.')).toBeLessThan(body.indexOf('| Operation'))
  })
})

describe('RFC-247 — markdown safety', () => {
  test('a pipe in a value cannot break out of its table cell', () => {
    const body = buildApiDocsMarkdown(
      payload({
        tools: [
          {
            name: 'weird',
            title: 'Weird',
            description: 'accepts a | b | c',
            permissions: [],
            grantable: true,
          },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('accepts a \\| b \\| c')
  })

  test('snippets are fenced with their own language', () => {
    const body = buildApiDocsMarkdown(
      payload({
        snippets: [
          { id: 'opencode', label: 'opencode', language: 'json', code: '{"oauth": false}' },
        ],
      }),
      STRINGS,
    )
    expect(body).toContain('```json\n{"oauth": false}\n```')
  })

  test('an empty section renders no headerless table', () => {
    const body = buildApiDocsMarkdown(payload({ endpoints: [], tools: [] }), STRINGS)
    // The headings survive (they explain the concept), the tables do not.
    expect(body).toContain('## TOOLS')
    expect(body).not.toContain('| Tool | Requires |')
  })
})

describe('RFC-247 AC-27 — one markdown rendering path', () => {
  const SRC = resolve(import.meta.dirname, '..', 'src')

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [full] : []
    })
  }

  /**
   * The one documented exception, predating RFC-247: RFC-010's review diff view
   * renders a merged document with inline ins/del markers, which is a different
   * job from "render this markdown" and shares Prose's plugin chain by hand.
   * It is allowlisted rather than ignored so the exception stays visible — and
   * so a SECOND one has to be argued for here rather than added quietly.
   */
  const ALLOWED = [join('components', 'review', 'MarkdownDiffView.tsx')]

  test('nothing new imports a markdown renderer directly', () => {
    // The wiki page renders generated markdown. The temptation on a page like
    // that is to reach for `react-markdown` directly "just for the docs" — and
    // then the docs page's tables, code blocks and links quietly stop matching
    // every other markdown surface in the app.
    const offenders = walk(SRC)
      .filter((f) => !f.includes(join('components', 'prose')))
      .filter((f) => !ALLOWED.some((allowed) => f.endsWith(allowed)))
      .filter((f) => {
        const source = readFileSync(f, 'utf8')
        return (
          source.includes("from 'react-markdown'") ||
          source.includes("from 'marked'") ||
          source.includes("from 'markdown-it'")
        )
      })
      .map((f) => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })

  test('the docs route renders through Prose', () => {
    const route = readFileSync(join(SRC, 'routes', 'docs.api.tsx'), 'utf8')
    expect(route).toContain("import { Prose } from '@/components/prose/Prose'")
    expect(route).toContain('<Prose')
    // …and builds its body from the payload rather than embedding prose here.
    expect(route).toContain('buildApiDocsMarkdown(payload')
  })
})

describe('RFC-247 — the markdown carve-out cannot silently widen', () => {
  const SRC2 = resolve(import.meta.dirname, '..', 'src')

  test('only title and subtitle are used outside the markdown builder', () => {
    // `onboarding-guide.test.tsx` allows `**` in `apiDocs.*` because those
    // strings are rendered as markdown. That exemption is only safe while the
    // ONLY apiDocs keys used in a plain-text slot are the two it excludes.
    // This is the other half of that argument: if a new key starts feeding
    // PageHeader (or any other plain slot), this goes red and the exemption
    // has to be re-argued rather than quietly covering it.
    const route = readFileSync(join(SRC2, 'routes', 'docs.api.tsx'), 'utf8')
    const builderStart = route.indexOf('buildApiDocsMarkdown(payload')
    expect(builderStart).toBeGreaterThan(-1)
    const builderEnd = route.indexOf('/>', builderStart)
    const outsideBuilder = route.slice(0, builderStart) + route.slice(builderEnd)

    const used = [...outsideBuilder.matchAll(/t\('(apiDocs\.[A-Za-z.]+)'\)/g)].map((m) => m[1])
    expect([...new Set(used)].sort()).toEqual(['apiDocs.subtitle', 'apiDocs.title'])
  })
})

describe('RFC-247 AC-44 — where the wiki is reachable from', () => {
  const SRC3 = resolve(import.meta.dirname, '..', 'src')

  test('it is NOT a sidebar entry', () => {
    // Reference material, not a place work happens. Putting it in the sidebar
    // would spend a permanent slot on a page most users read once.
    expect(readFileSync(join(SRC3, 'lib', 'nav.ts'), 'utf8')).not.toContain('/docs/api')
  })

  test('it IS reachable from the two places a user needs it', () => {
    // Beside the token they just minted ("what do I point this at"), and beside
    // the switch that governs the whole external surface.
    expect(
      readFileSync(join(SRC3, 'components', 'account', 'AccountTokensPanel.tsx'), 'utf8'),
    ).toContain('to="/docs/api"')
    expect(readFileSync(join(SRC3, 'routes', 'settings.tsx'), 'utf8')).toContain('to="/docs/api"')
  })
})
