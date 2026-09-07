import { expect, test } from 'bun:test'

import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { readPersistedDigitalEmployeeTypePackageDescriptorJsons } from '@/modules/digital-employee/composition'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/composition/agentTemplateCatalog'
import { composeDigitalEmployeeAgentTemplateCatalogFor } from '@/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { ensureDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('digital employee builtin tool catalog boot snapshot', (harness) => {
  test('repeated catalog reads do not issue SQLite selects after composition', async () => {
    const db = harness.db
    await ensureDigitalEmployeeAgentTemplates(
      composeDigitalEmployeeAgentTemplateCatalogFor(
        db,
        composeDigitalEmployeeAgentTemplateCatalogParticipant,
      ),
    )

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
    })

    const agentTemplates = composeDigitalEmployeeAgentTemplateCatalogFor(
      countedDb,
      composeDigitalEmployeeAgentTemplateCatalogParticipant,
    )
    const catalog = await composeDigitalEmployeeBuiltinToolCatalog({
      agentTemplates,
      typePackageDescriptorJsons: [
        ...(await readPersistedDigitalEmployeeTypePackageDescriptorJsons(countedDb)),
        developmentEmployeeTypePackage.descriptorJson,
      ],
    })
    const selectsAtComposition = selectCalls
    const typeRefJson = JSON.stringify({ typeId: 'development', revision: 10 })
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
