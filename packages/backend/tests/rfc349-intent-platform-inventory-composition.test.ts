import { describe, expect, test } from 'bun:test'

import type { Actor } from '@/auth/actor'
import type {
  DevelopmentConfigIdentityView,
  DevelopmentConfigResourceKind,
  DevelopmentConfigResourceOperations,
} from '@/modules/development-automation/public/operations'
import {
  composeDigitalEmployeePlatformInventoryParticipant,
  type DigitalEmployeeQueries,
} from '@/modules/digital-employee/composition'
import type { DigitalEmployeePlatformInventoryParticipant } from '@/modules/digital-employee/public/participants'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeIntentPlatformInventoryParticipant } from '@/modules/intent/composition/platformInventory'
import { platformOnlyResourceTypes } from '@/modules/intent/domain/teaching/platformMap'
import { composeIntentResourceCatalogFor } from '@/services/intent/resourceCatalog'

const ACTOR: Actor = {
  user: {
    id: 'inventory-owner',
    username: 'inventory-owner',
    displayName: 'Inventory Owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: new Set(),
}

function authority(userId: string): DirectAuthenticatedAuthority {
  return {
    ...ACTOR,
    user: { ...ACTOR.user, id: userId },
    userId,
  } as DirectAuthenticatedAuthority
}

function configResource(
  kind: DevelopmentConfigResourceKind,
  rows: readonly DevelopmentConfigIdentityView[],
): DevelopmentConfigResourceOperations {
  return {
    kind,
    async list() {
      return [...rows]
    },
    async get() {
      return null
    },
    async create() {
      throw new Error('not-used')
    },
    async revise() {
      throw new Error('not-used')
    },
    async publish() {
      throw new Error('not-used')
    },
    async archive() {
      throw new Error('not-used')
    },
    async loadAclRow() {
      return null
    },
  }
}

function configRow(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): DevelopmentConfigIdentityView {
  return {
    id,
    name,
    publishedRevision: null,
    ownerUserId: 'inventory-owner',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...extra,
  }
}

describe('RFC-349 Intent platform inventory composition', () => {
  test('the nine-type aggregate delegates only to owner-authorized query participants', async () => {
    const directAuthority = authority(ACTOR.user.id)
    const digitalCalls: string[] = []
    const digitalEmployee: DigitalEmployeePlatformInventoryParticipant = {
      async listVisibleRows(type, received) {
        expect(received).toBe(directAuthority)
        digitalCalls.push(type)
        return [{ id: type, name: `visible ${type}`, description: null }]
      },
    }
    const resources = {
      'action-template': configResource('action-template', [
        configRow('action-1', 'Action', { capabilityId: 'review' }),
      ]),
      'verification-profile': configResource('verification-profile', [
        configRow('verify-1', 'Verification', { publishedRevision: 3 }),
      ]),
      'digital-employee': configResource('digital-employee', [
        configRow('employee-config-1', 'Employee config', { description: 'Configured employee' }),
      ]),
      'automation-policy': configResource('automation-policy', [configRow('policy-1', 'Policy')]),
      'development-adapter': configResource('development-adapter', [
        configRow('adapter-1', 'Adapter', { purpose: 'code host bridge' }),
      ]),
    } satisfies Record<DevelopmentConfigResourceKind, DevelopmentConfigResourceOperations>

    const inventory = composeIntentPlatformInventoryParticipant({
      authorityFor(actor) {
        expect(actor).toBe(ACTOR)
        return directAuthority
      },
      capabilityTemplates: {
        async list(received) {
          expect(received).toBe(directAuthority)
          return [{ id: 'cap-1', name: 'Capability', description: 'Code review' }]
        },
      },
      developmentConfig: { resources },
      digitalEmployee,
    })

    const byType = new Map(
      await Promise.all(
        platformOnlyResourceTypes().map(
          async (type) => [type, await inventory.listRows(type, ACTOR)] as const,
        ),
      ),
    )
    expect([...byType.keys()]).toEqual([...platformOnlyResourceTypes()])
    expect(byType.get('capability_template')).toEqual([
      { id: 'cap-1', name: 'Capability', description: 'Code review' },
    ])
    expect(byType.get('action_template')?.[0]?.description).toBe('capability review; draft')
    expect(byType.get('verification_profile')?.[0]?.description).toBe('published r3')
    expect(byType.get('digital_employee')?.[0]?.description).toBe('Configured employee')
    expect(byType.get('automation_policy')?.[0]?.description).toBe('draft')
    expect(byType.get('development_adapter')?.[0]?.description).toBe('code host bridge')
    expect(digitalCalls.sort()).toEqual(
      ['employee_definition', 'employee_job_template', 'employee_tool'].sort(),
    )
  })

  test('Digital Employee owner adapter filters definitions, jobs and tools before projection', async () => {
    const owner = authority('inventory-owner')
    const stranger = authority('inventory-stranger')
    const visibility = [
      { suffix: 'mine', ownerUserId: owner.user.id, visibility: 'private' as const },
      { suffix: 'public', ownerUserId: owner.user.id, visibility: 'public' as const },
      { suffix: 'theirs', ownerUserId: stranger.user.id, visibility: 'private' as const },
    ]
    const queries: Pick<
      DigitalEmployeeQueries,
      'listTypes' | 'listTools' | 'listJobTemplates' | 'listEmployees'
    > = {
      async listTypes() {
        return [
          {
            typeRef: { typeId: 'platform-type', revision: 1 },
            authoringManifest: { workItems: [{ workItemRef: 'build' }] },
          } as never,
        ]
      },
      async listEmployees() {
        return visibility.map((row) => ({
          id: `employee-${row.suffix}`,
          name: `employee ${row.suffix}`,
          typeRef: { typeId: 'platform-type', revision: 1 },
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })) as never
      },
      async listJobTemplates() {
        return visibility.map((row) => ({
          id: `job-${row.suffix}`,
          name: `job ${row.suffix}`,
          typeRef: { typeId: 'platform-type', revision: 1 },
          draft: { description: { en: `job description ${row.suffix}` } },
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })) as never
      },
      async listTools() {
        return visibility.map((row) => ({
          id: `tool-${row.suffix}`,
          typeRef: { typeId: 'platform-type', revision: 1 },
          workItemRef: 'build',
          content: {
            displayName: { en: `tool ${row.suffix}` },
            description: { en: `tool description ${row.suffix}` },
          },
          origin: 'custom',
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })) as never
      },
    }
    const participant = composeDigitalEmployeePlatformInventoryParticipant({
      queries,
      access: {
        async filterVisibleRows(current, _type, rows) {
          return rows.filter(
            (row) => row.visibility === 'public' || row.ownerUserId === current.user.id,
          )
        },
      },
    })

    for (const type of ['employee_definition', 'employee_job_template', 'employee_tool'] as const) {
      const ownerRows = await participant.listVisibleRows(type, owner)
      expect(
        ownerRows.map((row) => row.id),
        type,
      ).toEqual([
        `${type === 'employee_definition' ? 'employee' : type === 'employee_job_template' ? 'job' : 'tool'}-mine`,
        `${type === 'employee_definition' ? 'employee' : type === 'employee_job_template' ? 'job' : 'tool'}-public`,
      ])
      const strangerRows = await participant.listVisibleRows(type, stranger)
      expect(
        strangerRows.map((row) => row.id),
        type,
      ).toEqual([
        `${type === 'employee_definition' ? 'employee' : type === 'employee_job_template' ? 'job' : 'tool'}-public`,
        `${type === 'employee_definition' ? 'employee' : type === 'employee_job_template' ? 'job' : 'tool'}-theirs`,
      ])
    }
  })

  test('resourceCatalogFor binds one branded authority across all owner detail queries', async () => {
    const directAuthority = authority(ACTOR.user.id)
    const context = Object.freeze({}) as never
    const calls: string[] = []
    const resourceCatalogFor = composeIntentResourceCatalogFor({
      query: {
        async listVisible(received) {
          expect(received).toBe(context)
          return { items: [], nextCursor: null }
        },
        async getVisibleSummary() {
          return null
        },
      },
      contextFor(actor) {
        expect(actor).toBe(ACTOR)
        return context
      },
      authorityFor(actor) {
        expect(actor).toBe(ACTOR)
        return directAuthority
      },
      catalogs: {
        agents: {
          async get(received) {
            expect(received).toBe(directAuthority)
            calls.push('agent')
            return null
          },
        },
        skills: {
          async content(received) {
            expect(received).toBe(directAuthority)
            calls.push('skill')
            return {} as never
          },
        },
        skillFiles: {
          async list(received) {
            expect(received).toBe(directAuthority)
            calls.push('skill-files-list')
            return []
          },
          async read(received) {
            expect(received).toBe(directAuthority)
            calls.push('skill-files-read')
            return { path: 'README.md', content: '# skill' }
          },
        },
        mcps: {
          async get(received) {
            expect(received).toBe(directAuthority)
            calls.push('mcp')
            return null
          },
        },
        plugins: {
          async get(received) {
            expect(received).toBe(directAuthority)
            calls.push('plugin')
            return null
          },
        },
        workflows: {
          async get(received) {
            expect(received).toBe(directAuthority)
            calls.push('workflow')
            return null
          },
        },
        workgroups: {
          async get(received) {
            expect(received).toBe(directAuthority)
            calls.push('workgroup')
            return null
          },
        },
      },
    })

    const binding = resourceCatalogFor(ACTOR)
    await binding.query.listVisible(binding.context, { limit: 1 })
    await binding.details.agents.get({} as never)
    await binding.details.skills.content({} as never)
    await binding.details.skillFiles.list({} as never)
    await binding.details.skillFiles.read({} as never)
    await binding.details.mcps.get({} as never)
    await binding.details.plugins.get({} as never)
    await binding.details.workflows.get({} as never)
    await binding.details.workgroups.get({} as never)
    expect(calls).toEqual([
      'agent',
      'skill',
      'skill-files-list',
      'skill-files-read',
      'mcp',
      'plugin',
      'workflow',
      'workgroup',
    ])
  })
})
