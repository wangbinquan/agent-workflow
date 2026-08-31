// RFC-345 T4a — legacy mapper/policy bundle injected into Resource Catalog.
// This is the only compatibility edge; task-execution consumers receive only
// the named public participant and frozen data-only snapshots.

import { canViewResourceInTx } from '@/services/resourceAcl'
import { rowToAgent } from '@/services/agent'
import { rowToMcp } from '@/services/mcp'
import { rowToPlugin } from '@/services/plugin'
import { rowToWorkflowDetail } from '@/services/workflow'
import { rowToWorkgroup } from '@/services/workgroups'
import { assertNotBuiltin } from '@/services/systemResources'
import { isSkillInjectableThisBoot } from '@/services/skillBootVerify'
import { skillFilesRel } from '@/services/skillIdentityPaths'
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
