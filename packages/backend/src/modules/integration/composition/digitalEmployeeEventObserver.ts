// RFC-500 (RFC-294 S10 step 7): the observers live in application/developmentEventObservers.ts. This file only assembles
// them for the deployment's code-host binding and approval gateway, with the process clock and id source.
import { randomUUID } from 'node:crypto'

import {
  createDevelopmentApprovalEventObserver,
  createDevelopmentCodeHostEventObserver,
  createDevelopmentEmployeeEventObserver,
} from '../application/developmentEventObservers'

/** The development employee event observer: code-host activity and external approval state, dispatched by source. */
export function composeDevelopmentEmployeeEventObserver(input: {
  readonly binding: Parameters<typeof createDevelopmentCodeHostEventObserver>[0]['binding']
  readonly gateway: Parameters<typeof createDevelopmentApprovalEventObserver>[0]['gateway']
}) {
  return createDevelopmentEmployeeEventObserver({
    codeHost: createDevelopmentCodeHostEventObserver({
      binding: input.binding,
      now: Date.now,
      activationRef: randomUUID,
    }),
    approval: createDevelopmentApprovalEventObserver({ gateway: input.gateway, now: Date.now }),
  })
}
