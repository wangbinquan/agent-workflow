import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '@/db/client'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { readPersistedDigitalEmployeeTypePackageDescriptorJsons } from '@/modules/digital-employee/composition'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { ensureDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('digital employee builtin tool catalog boot snapshot', () => {
  test('repeated catalog reads do not issue SQLite selects after composition', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await ensureDigitalEmployeeAgentTemplates(db)

    let selectCalls = 0
    const countedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'select') {
          const select = target.select.bind(target)
          return (...args: Parameters<typeof target.select>) => {
            selectCalls += 1
            return select(...args)
          }
        }
        return Reflect.get(target, property, target)
      },
    }) as DbClient

    const catalog = composeDigitalEmployeeBuiltinToolCatalog({
      db: countedDb,
      typePackageDescriptorJsons: [
        ...readPersistedDigitalEmployeeTypePackageDescriptorJsons(countedDb),
        developmentEmployeeTypePackage.descriptorJson,
      ],
    })
    const selectsAtComposition = selectCalls
    const typeRefJson = JSON.stringify({ typeId: 'development', revision: 9 })
    const tools = JSON.parse(catalog.listJson(typeRefJson, 'repair-feedback')) as Array<{
      id: string
      publishedRevision: number
    }>
    expect(tools).not.toHaveLength(0)

    catalog.listJson(typeRefJson, 'repair-feedback')
    expect(
      catalog.getRevisionJson(
        JSON.stringify({ id: tools[0]!.id, revision: tools[0]!.publishedRevision }),
      ),
    ).not.toBeNull()
    expect(selectCalls).toBe(selectsAtComposition)
  })
})
