// RFC-471: the pipeline evidence compositions are no longer public — their only cross-module consumer
// (`services/developmentDeliveryDeps.ts`) moved into this module's `composition/developmentDelivery.ts`.
export {
  assertEvidenceStagingFactory,
  assertEvidenceStagingLease,
} from '../application/evidenceStaging'

// RFC-544: the builtin agent templates live in domain/application; bootstrap takes these names from here.
export {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '../application/digitalEmployeeAgentTemplates'
export {
  DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
  digitalEmployeeAgentToolPresentation,
  digitalEmployeeBuiltinAgentSuccessorId,
  digitalEmployeeBuiltinToolConfiguration,
} from '../domain/legacyDigitalEmployeeAgentTemplates'
