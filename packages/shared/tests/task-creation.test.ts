import { describe, expect, test } from 'bun:test'

import {
  TASK_CREATION_STEPS,
  TASK_SOURCE_IDS,
  TASK_SOURCE_REGISTRATIONS,
  taskSourceRegistration,
} from '../src/taskCreation'

describe('unified task source registry', () => {
  test('registers every source once for creation, list, filter and detail', () => {
    expect(TASK_SOURCE_REGISTRATIONS.map((registration) => registration.id)).toEqual(
      TASK_SOURCE_IDS,
    )
    expect(new Set(TASK_SOURCE_REGISTRATIONS.map((registration) => registration.id)).size).toBe(
      TASK_SOURCE_REGISTRATIONS.length,
    )
    for (const registration of TASK_SOURCE_REGISTRATIONS) {
      expect(registration.creation.steps).toEqual(TASK_CREATION_STEPS)
      expect(Object.keys(registration.creation).sort()).toEqual([
        'inventoryPath',
        'parameterContract',
        'requiredPermission',
        'resourceSearchKey',
        'steps',
        'supportsRelaunch',
        'supportsSchedule',
      ])
      expect(Object.keys(registration.list).sort()).toEqual(['detailPath', 'requiredPermission'])
      expect(registration.list.detailPath).toStartWith('/tasks/')
    }
  })

  test('digital employee parameters come from its type descriptor and only current employees launch', () => {
    expect(taskSourceRegistration('digital-employee')).toMatchObject({
      creation: {
        inventoryPath: '/api/digital-employees/launchable',
        requiredPermission: 'development-missions:launch',
        parameterContract: {
          kind: 'subject-descriptor',
          schemaId: 'digital-employee-intake@1',
          descriptorField: 'workIntakeAuthoring',
        },
        supportsSchedule: false,
        supportsRelaunch: false,
      },
      list: {
        requiredPermission: 'digital-employees:read',
        detailPath: '/tasks/employee-cases/$caseId',
      },
    })
  })
})
