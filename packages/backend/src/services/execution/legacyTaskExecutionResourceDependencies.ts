// RFC-345 T4a — legacy mapper/policy bundle injected into Resource Catalog.
// This is the only compatibility edge; task-execution consumers receive only
// the named public participant and frozen data-only snapshots.

import { canViewResourceInTx } from '@/modules/resource-catalog/composition/resourceAcl'
import { rowToAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { mcpFromPersistenceRow as rowToMcp } from '@/modules/resource-catalog/infrastructure/mcpPersistence'
import { pluginFromPersistenceRow as rowToPlugin } from '@/modules/resource-catalog/infrastructure/pluginPersistence'
import { rowToWorkflowDetail } from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import { rowToWorkgroup } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import { assertNotBuiltin } from '@/services/systemResources'
import { isSkillInjectableThisBoot } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { skillFilesRel } from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
} from '@/services/runtime/injectionIdentity'
import { PLUGIN_DISABLED_ERROR_CODE } from '@/services/execution/resourcePolicy'
import { pickCallTarget } from '@/services/execution/callRefTarget'

export const legacyTaskExecutionResourceDependencies = Object.freeze({
  canViewResourceInTx,
  rowToAgent,
  rowToMcp,
  rowToPlugin,
  rowToWorkflowDetail,
  rowToWorkgroup,
  assertNotBuiltin,
  isSkillInjectableThisBoot,
  skillFilesRel,
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
  pluginDisabledErrorCode: PLUGIN_DISABLED_ERROR_CODE,
  pickCallTarget,
})
