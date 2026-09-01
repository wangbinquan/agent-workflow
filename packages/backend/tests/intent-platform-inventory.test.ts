// RFC-348 D3 / RFC-349 — Intent consumes platform-only inventory through a
// closed provider-neutral participant. Owning contexts authorize and project
// rows; this consumer only renders the read-only files.

import { describe, expect, test } from 'bun:test'
import {
  INTENT_RESOURCE_TYPES,
  IntentMountRequestsSchema,
  parseIntentChangeset,
} from '@agent-workflow/shared'

import type { Actor } from '../src/auth/actor'
import {
  platformOnlyResourceTypes,
  type PlatformOnlyResourceType,
} from '../src/modules/intent/domain/teaching/platformMap'
import type { IntentPlatformInventoryParticipant } from '../src/modules/intent/public/operations'
import type { IntentResourceCatalogBinding } from '../src/services/intent/resourceCatalog'
import { buildIntentDump } from '../src/services/intent/dumpBuilder'
import {
  PLATFORM_INVENTORY_ROW_CAP,
  platformInventoryTypes,
  renderPlatformInventoryFile,
} from '../src/services/intent/platformInventory'

const ACTOR: Actor = {
  user: {
    id: 'user_owner_pinv_00000000000',
    username: 'pinv-owner',
    displayName: 'Inventory Owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: new Set(),
}

const EMPTY_RESOURCE_CATALOG = {
  context: {},
  query: {
    async listVisible() {
      return { items: [], nextCursor: null }
    },
  },
  details: {},
} as unknown as IntentResourceCatalogBinding

describe('RFC-348 — platform-only inventory', () => {
  test('pure roster and renderer stay closed over the platform map', () => {
    expect(platformInventoryTypes()).toEqual(platformOnlyResourceTypes())
    const many = Array.from({ length: PLATFORM_INVENTORY_ROW_CAP + 3 }, (_, index) => ({
      id: `id-${index}`,
      name: `row-${String(index).padStart(4, '0')}`,
      description: index === 0 ? 'first line\nsecret second line' : null,
    }))
    const rendered = renderPlatformInventoryFile('action_template', many)
    expect(rendered).toContain('TRUNCATED — 3 more not listed')
    expect(rendered).toContain('`row-0000` — first line')
    expect(rendered).not.toContain('secret second line')
    expect(rendered).not.toContain('row-0202')
    expect(rendered).not.toContain('res#')
  })

  test('dump calls the injected participant once per type and writes read-only files', async () => {
    const calls: PlatformOnlyResourceType[] = []
    const platformInventory: IntentPlatformInventoryParticipant = {
      async listRows(type) {
        calls.push(type)
        return type === 'digital_employee'
          ? [{ id: 'employee-1', name: 'Build Concierge', description: 'published r1' }]
          : []
      },
    }
    const dump = await buildIntentDump({
      actor: ACTOR,
      resourceCatalog: EMPTY_RESOURCE_CATALOG,
      appHome: '/tmp/rfc349-intent-platform-inventory',
      mounts: [],
      runtimeInventory: {
        async list() {
          return []
        },
        async resolveDefault() {
          return { name: 'opencode', protocol: 'opencode' }
        },
      },
      async loadAgentPorts() {
        return new Map()
      },
      platformInventory,
    })

    expect(calls).toEqual([...platformOnlyResourceTypes()])
    for (const type of platformOnlyResourceTypes()) {
      const file = dump.seedFiles.find((candidate) => {
        return candidate.path === `inventory/platform/${type}.md`
      })
      expect(file, type).toBeDefined()
      expect(file?.content).toContain('read-only — cannot be referenced')
      expect(file?.content).not.toContain('res#')
    }
    expect(
      dump.seedFiles.find((file) => file.path === 'inventory/platform/digital_employee.md')
        ?.content,
    ).toContain('`Build Concierge` — published r1')
  })

  test('a platform-only type cannot be named in a changeset op or mount request', () => {
    for (const type of platformOnlyResourceTypes()) {
      expect((INTENT_RESOURCE_TYPES as readonly string[]).includes(type)).toBe(false)
      const parsed = parseIntentChangeset(
        JSON.stringify({
          $schema_version: 1,
          ops: [
            {
              opId: 'op-1',
              action: 'create',
              resourceType: type,
              tempRef: '$new:x',
              payload: { name: 'x' },
            },
          ],
        }),
      )
      expect(parsed.ok, type).toBe(false)
      expect(
        IntentMountRequestsSchema.safeParse([{ resourceType: type, name: 'x' }]).success,
        type,
      ).toBe(false)
    }
  })
})
