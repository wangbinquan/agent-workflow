// RFC-310 — registration contract for every task-producing capability.
//
// The platform owns one task creation shell, one task list and one set of
// filters. A task source contributes only declarative metadata and contracts;
// the shared creation UI consumes those contracts directly. There is no
// intermediate dispatch identity and no source-owned page renderer.

export const TASK_CREATION_STEPS = ['mode', 'space', 'content', 'confirm'] as const
export type TaskCreationStep = (typeof TASK_CREATION_STEPS)[number]

export const TASK_SOURCE_IDS = ['agent', 'workflow', 'workgroup', 'digital-employee'] as const
export type TaskSourceId = (typeof TASK_SOURCE_IDS)[number]

/** Every creation kind is the identity of its task source. */
export type TaskCreationKind = TaskSourceId

export type TaskCreationParameterContract =
  | {
      readonly kind: 'shared-schema'
      readonly schemaId: 'agent-start@1' | 'workflow-start@1' | 'workgroup-start@1'
    }
  | {
      readonly kind: 'subject-descriptor'
      readonly schemaId: 'digital-employee-intake@1'
      readonly descriptorField: 'workIntakeAuthoring'
    }

export interface TaskCreationRegistration {
  readonly inventoryPath: string
  readonly resourceSearchKey: 'agentId' | 'workflow' | 'workgroupId' | 'employeeId'
  readonly requiredPermission: 'tasks:execute' | 'development-missions:launch'
  readonly steps: readonly TaskCreationStep[]
  readonly parameterContract: TaskCreationParameterContract
  readonly supportsSchedule: boolean
  readonly supportsRelaunch: boolean
}

export interface TaskListRegistration {
  readonly requiredPermission: 'tasks:read' | 'digital-employees:read'
  readonly detailPath: string
}

export interface TaskSourceRegistration {
  readonly id: TaskSourceId
  readonly order: number
  readonly catalogPath: '/agents' | '/workflows' | '/workgroups' | '/digital-employees'
  readonly labelKey: string
  readonly descriptionKey: string
  readonly creation: TaskCreationRegistration
  readonly list: TaskListRegistration
}

function defineTaskSource(registration: TaskSourceRegistration): TaskSourceRegistration {
  return registration
}

const agentTaskSource = defineTaskSource({
  id: 'agent',
  order: 10,
  catalogPath: '/agents',
  labelKey: 'taskWizard.kindAgent',
  descriptionKey: 'taskWizard.kindHintAgent',
  creation: {
    inventoryPath: '/api/agents',
    resourceSearchKey: 'agentId',
    requiredPermission: 'tasks:execute',
    steps: TASK_CREATION_STEPS,
    parameterContract: { kind: 'shared-schema', schemaId: 'agent-start@1' },
    supportsSchedule: true,
    supportsRelaunch: true,
  },
  list: {
    requiredPermission: 'tasks:read',
    detailPath: '/tasks/$id',
  },
})

const workflowTaskSource = defineTaskSource({
  id: 'workflow',
  order: 20,
  catalogPath: '/workflows',
  labelKey: 'taskWizard.kindWorkflow',
  descriptionKey: 'taskWizard.kindHintWorkflow',
  creation: {
    inventoryPath: '/api/workflows',
    resourceSearchKey: 'workflow',
    requiredPermission: 'tasks:execute',
    steps: TASK_CREATION_STEPS,
    parameterContract: { kind: 'shared-schema', schemaId: 'workflow-start@1' },
    supportsSchedule: true,
    supportsRelaunch: true,
  },
  list: {
    requiredPermission: 'tasks:read',
    detailPath: '/tasks/$id',
  },
})

const workgroupTaskSource = defineTaskSource({
  id: 'workgroup',
  order: 30,
  catalogPath: '/workgroups',
  labelKey: 'taskWizard.kindWorkgroup',
  descriptionKey: 'taskWizard.kindHintWorkgroup',
  creation: {
    inventoryPath: '/api/workgroups',
    resourceSearchKey: 'workgroupId',
    requiredPermission: 'tasks:execute',
    steps: TASK_CREATION_STEPS,
    parameterContract: { kind: 'shared-schema', schemaId: 'workgroup-start@1' },
    supportsSchedule: true,
    supportsRelaunch: true,
  },
  list: {
    requiredPermission: 'tasks:read',
    detailPath: '/tasks/$id',
  },
})

const digitalEmployeeTaskSource = defineTaskSource({
  id: 'digital-employee',
  order: 40,
  catalogPath: '/digital-employees',
  labelKey: 'taskWizard.kindDigitalEmployee',
  descriptionKey: 'taskWizard.kindHintDigitalEmployee',
  creation: {
    inventoryPath: '/api/digital-employees/launchable',
    resourceSearchKey: 'employeeId',
    requiredPermission: 'development-missions:launch',
    steps: TASK_CREATION_STEPS,
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

/** Composition catalog: adding a source means registering one value here. */
export const TASK_SOURCE_REGISTRATIONS = [
  agentTaskSource,
  workflowTaskSource,
  workgroupTaskSource,
  digitalEmployeeTaskSource,
] as const satisfies readonly TaskSourceRegistration[]

export function isTaskSourceId(value: unknown): value is TaskSourceId {
  return TASK_SOURCE_IDS.includes(value as TaskSourceId)
}

export function taskSourceRegistration(id: TaskSourceId): TaskSourceRegistration {
  const registration = TASK_SOURCE_REGISTRATIONS.find((candidate) => candidate.id === id)
  if (registration === undefined) throw new Error(`task source not registered: ${id}`)
  return registration
}
