import { renderTemplate, type TriggerContext } from '@agent-workflow/shared'

import type {
  EmployeeAutomationWorkStartV1,
  TaskAutomationWorkStartV1,
} from '../composition/required-ports'
import type { EventResponseTarget } from '../domain/responseRule'

export type MaterializedEventAutomationTarget =
  | Readonly<{
      kind: 'task'
      portId: 'task-automation-work-start.v1'
      input: TaskAutomationWorkStartV1
    }>
  | Readonly<{
      kind: 'employee'
      portId: 'employee-automation-work-start.v1'
      input: EmployeeAutomationWorkStartV1
    }>

/** The sole production renderer for source-neutral Event Response rules. */
export function materializeEventAutomationTarget(
  target: EventResponseTarget,
  trigger: TriggerContext,
): MaterializedEventAutomationTarget {
  const render = (value: string) => renderTemplate(value, trigger)
  if (target.kind === 'workflow') {
    return {
      kind: 'task',
      portId: 'task-automation-work-start.v1',
      input: {
        version: 1,
        trigger,
        target: {
          kind: 'workflow',
          refId: target.refId,
          payload: {
            workflowId: target.refId,
            name: render(target.nameTemplate),
            inputs: Object.fromEntries(
              Object.entries(target.inputs).map(([key, value]) => [key, render(value)]),
            ),
            scratch: true,
          },
        },
      },
    }
  }
  if (target.kind === 'agent') {
    return {
      kind: 'task',
      portId: 'task-automation-work-start.v1',
      input: {
        version: 1,
        trigger,
        target: {
          kind: 'agent',
          refId: target.refId,
          payload: {
            agentId: target.refId,
            name: render(target.nameTemplate),
            allowClarify: true,
            ...(target.descriptionTemplate === null
              ? {}
              : { description: render(target.descriptionTemplate) }),
            ...(Object.keys(target.inputs).length === 0
              ? {}
              : {
                  inputs: Object.fromEntries(
                    Object.entries(target.inputs).map(([key, value]) => [key, render(value)]),
                  ),
                }),
            scratch: true,
          },
        },
      },
    }
  }
  if (target.kind === 'workgroup') {
    return {
      kind: 'task',
      portId: 'task-automation-work-start.v1',
      input: {
        version: 1,
        trigger,
        target: {
          kind: 'workgroup',
          refId: target.refId,
          payload: {
            workgroupId: target.refId,
            name: render(target.nameTemplate),
            goal: render(target.goalTemplate),
            scratch: true,
          },
        },
      },
    }
  }
  return {
    kind: 'employee',
    portId: 'employee-automation-work-start.v1',
    input: {
      version: 1,
      employeeId: target.refId,
      intake: {
        kind: target.intakeKind,
        target: Object.fromEntries(
          Object.entries(target.target).map(([key, value]) => [key, render(value)]),
        ),
        body: target.intakeKind === 'body' ? render(target.valueTemplate) : null,
        externalId: target.intakeKind === 'external-id' ? render(target.valueTemplate) : null,
        uploads: [],
      },
    },
  }
}
