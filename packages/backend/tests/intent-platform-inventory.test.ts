// RFC-348 D3 (AC-16, user ruling ③) — the nine platform-only ACL types appear as
// read-only inventory files (`inventory/platform/<type>.md`): every type is
// visibility-filtered with the same judgement the REST lists use (two-actor
// table below), rows carry no handle, files are capped, employee tools merge the
// DB registrations with the platform catalog (DB wins on a duplicate id), and a
// platform-only type still cannot be named in a changeset op OR a mount request.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import {
  INTENT_RESOURCE_TYPES,
  IntentMountRequestsSchema,
  parseIntentChangeset,
} from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  actionTemplates,
  automationPolicies,
  capabilityTemplates,
  developmentAdapterDefinitions,
  digitalEmployees,
  users,
  verificationProfiles,
} from '../src/db/schema'
import {
  platformOnlyResourceTypes,
  type PlatformOnlyResourceType,
} from '../src/modules/intent/domain/teaching/platformMap'
import type { DigitalEmployeePlatformToolCatalogParticipant } from '../src/modules/digital-employee/public/types'
import { buildIntentDump } from '../src/services/intent/dumpBuilder'
import {
  PLATFORM_INVENTORY_ROW_CAP,
  PLATFORM_ONLY_INVENTORY_LOADERS,
  createDefaultIntentPlatformInventory,
  renderPlatformInventoryFile,
  type IntentEmployeeAuthoringReads,
} from '../src/services/intent/platformInventory'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_pinv_00000000000'
const STRANGER = 'user_stranger_pinv_00000000'

let db: DbClient
let appHome: string

function actorFor(id: string): Actor {
  return {
    user: {
      id,
      username: `u-${id.slice(5, 12)}`,
      displayName: 'U',
      role: 'user',
      status: 'active',
    },
    source: 'session',
    permissions: new Set(['resource-acl:private']),
  }
}

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({
    id,
    username: `u-${id.slice(5, 12)}`,
    displayName: `User ${id.slice(5, 9)}`,
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
}

interface SeedRow {
  name: string
  ownerUserId: string
  visibility: 'private' | 'public'
}

// ---------------------------------------------------------------------------
// Fixtures: the six identity-row tables are seeded directly; the three employee
// types go through the store slice the loaders read (`IntentEmployeeAuthoringReads`),
// stubbed in memory so no type-package descriptor / tool content JSON is needed.
// ---------------------------------------------------------------------------
const employeeRows: Record<
  'employee_definition' | 'employee_job_template' | 'employee_tool',
  SeedRow[]
> = {
  employee_definition: [],
  employee_job_template: [],
  employee_tool: [],
}
const TYPE_REF = { typeId: 'stub-type', revision: 1 }

function stubEmployeeReads(): IntentEmployeeAuthoringReads {
  return {
    listTypePackages: () =>
      [
        {
          descriptor: { typeRef: TYPE_REF },
          descriptorDigest: 'd',
          state: 'active',
          registeredAt: 1,
        },
      ] as never,
    listTypePackageDescriptorJsons: () => [],
    listEmployeeDefinitions: () =>
      employeeRows.employee_definition.map((row, i) => ({
        id: `emp-${i}`,
        name: row.name,
        typeRef: TYPE_REF,
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
      })) as never,
    listJobTemplates: () =>
      employeeRows.employee_job_template.map((row, i) => ({
        id: `job-${i}`,
        name: row.name,
        typeRef: TYPE_REF,
        draft: { description: 'from draft' },
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
      })) as never,
    listTools: () =>
      employeeRows.employee_tool.map((row, i) => ({
        id: `tool-${i}`,
        typeRef: TYPE_REF,
        workItemRef: 'wi',
        content: { displayName: row.name, description: 'from db' },
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
      })) as never,
  }
}

const emptyCatalog = (): DigitalEmployeePlatformToolCatalogParticipant =>
  ({
    listJson: () => '[]',
    getRevisionJson: () => null,
  }) as unknown as DigitalEmployeePlatformToolCatalogParticipant

type Seeder = (row: SeedRow) => void
const SEEDERS: Record<PlatformOnlyResourceType, Seeder> = {
  capability_template: (row) => {
    const now = Date.now()
    db.insert(capabilityTemplates)
      .values({
        id: ulid(),
        name: row.name,
        description: 'a template',
        capability: 'code-review',
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
        builtin: false,
        createdAt: now,
        updatedAt: now,
      } as typeof capabilityTemplates.$inferInsert)
      .run()
  },
  digital_employee: (row) => identityInsert(digitalEmployees, row),
  automation_policy: (row) => identityInsert(automationPolicies, row),
  action_template: (row) => identityInsert(actionTemplates, row, { capabilityId: 'cap-x' }),
  verification_profile: (row) => identityInsert(verificationProfiles, row),
  development_adapter: (row) =>
    identityInsert(developmentAdapterDefinitions, row, { purpose: 'bridges' }),
  employee_definition: (row) => employeeRows.employee_definition.push(row),
  employee_job_template: (row) => employeeRows.employee_job_template.push(row),
  employee_tool: (row) => employeeRows.employee_tool.push(row),
}

function identityInsert(
  table:
    | typeof digitalEmployees
    | typeof automationPolicies
    | typeof actionTemplates
    | typeof verificationProfiles
    | typeof developmentAdapterDefinitions,
  row: SeedRow,
  extra: Record<string, unknown> = {},
): void {
  const now = Date.now()
  db.insert(table)
    .values({
      id: ulid(),
      name: row.name,
      draftJson: '{}',
      publishedRevision: null,
      ownerUserId: row.ownerUserId,
      visibility: row.visibility,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ...extra,
    } as never)
    .run()
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  appHome = mkdtempSync(join(tmpdir(), 'aw-intent-pinv-'))
  for (const key of Object.keys(employeeRows) as Array<keyof typeof employeeRows>)
    employeeRows[key] = []
  await seedUser(OWNER)
  await seedUser(STRANGER)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

const inventory = () =>
  createDefaultIntentPlatformInventory(db, {
    employeeReads: stubEmployeeReads(),
    employeeToolCatalog: emptyCatalog,
  })

describe('RFC-348 — platform-only inventory', () => {
  test('loader roster = platform map roster; every loader answers on an empty database', async () => {
    expect(Object.keys(PLATFORM_ONLY_INVENTORY_LOADERS).sort()).toEqual(
      [...platformOnlyResourceTypes()].sort(),
    )
    const real = createDefaultIntentPlatformInventory(db)
    for (const type of platformOnlyResourceTypes()) {
      const rows = await real.listRows(type, actorFor(OWNER))
      expect(Array.isArray(rows), type).toBe(true)
    }
  })

  test('every one of the nine types is visibility-filtered like the REST list (two actors)', async () => {
    for (const type of platformOnlyResourceTypes()) {
      SEEDERS[type]({ name: `${type}-mine-private`, ownerUserId: OWNER, visibility: 'private' })
      SEEDERS[type]({ name: `${type}-public`, ownerUserId: OWNER, visibility: 'public' })
      SEEDERS[type]({
        name: `${type}-theirs-private`,
        ownerUserId: STRANGER,
        visibility: 'private',
      })
    }
    const inv = inventory()
    for (const type of platformOnlyResourceTypes()) {
      const mine = (await inv.listRows(type, actorFor(OWNER))).map((r) => r.name)
      expect(mine, `${type} for owner`).toEqual([`${type}-mine-private`, `${type}-public`])
      const theirs = (await inv.listRows(type, actorFor(STRANGER))).map((r) => r.name)
      expect(theirs, `${type} for stranger`).toEqual([`${type}-public`, `${type}-theirs-private`])
    }
  })

  test('employee_tool merges DB registrations with the platform catalog; DB wins on a duplicate id', async () => {
    employeeRows.employee_tool.push({ name: 'DB tool', ownerUserId: OWNER, visibility: 'private' })
    const catalog = (): DigitalEmployeePlatformToolCatalogParticipant =>
      ({
        listJson: () =>
          JSON.stringify([
            {
              id: 'tool-0',
              content: { displayName: 'Platform copy of tool-0' },
              visibility: 'public',
            },
            {
              id: 'platform-1',
              content: { displayName: 'Platform tool', description: 'built in' },
              visibility: 'public',
            },
          ]),
        getRevisionJson: () => null,
      }) as unknown as DigitalEmployeePlatformToolCatalogParticipant
    const inv = createDefaultIntentPlatformInventory(db, {
      employeeReads: stubEmployeeReads(),
      employeeToolCatalog: catalog,
    })
    const mine = await inv.listRows('employee_tool', actorFor(OWNER))
    expect(mine.map((r) => r.name)).toEqual(['DB tool', 'Platform tool'])
    expect(mine.find((r) => r.name === 'DB tool')?.description).toContain('from db')
    expect(mine.find((r) => r.name === 'Platform tool')?.description).toContain('built in')
    const theirs = await inv.listRows('employee_tool', actorFor(STRANGER))
    expect(theirs.map((r) => r.name)).toEqual(['Platform tool'])
  })

  test('the dump writes one read-only file per type, without handles, and states truncation', async () => {
    SEEDERS.digital_employee({ name: 'mine-private', ownerUserId: OWNER, visibility: 'private' })
    const dump = await buildIntentDump({
      db,
      actor: actorFor(OWNER),
      appHome,
      mounts: [],
      platformInventory: inventory(),
    })
    for (const type of platformOnlyResourceTypes()) {
      const file = dump.seedFiles.find((f) => f.path === `inventory/platform/${type}.md`)
      expect(file, type).toBeDefined()
      expect(file?.content).toContain(`# ${type} (`)
      expect(file?.content).toContain('read-only — cannot be referenced')
      expect(file?.content).not.toContain('res#')
    }
    const employees = dump.seedFiles.find(
      (f) => f.path === 'inventory/platform/digital_employee.md',
    )
    expect(employees?.content).toContain('`mine-private`')

    const many = Array.from({ length: PLATFORM_INVENTORY_ROW_CAP + 3 }, (_, i) => ({
      id: `id-${i}`,
      name: `row-${String(i).padStart(4, '0')}`,
      description: null,
    }))
    const rendered = renderPlatformInventoryFile('action_template', many)
    expect(rendered).toContain(`TRUNCATED — 3 more not listed`)
    expect(rendered).not.toContain('row-0202')
  })

  test('a platform-only type still cannot be named in a changeset op or a mount request', () => {
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
