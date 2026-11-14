// RFC-310 OS revision -- the development employee is a type package. Bootstrap registers this descriptor through
// digital-employee's public contract; the OS never imports this module.
//
// RFC-494 (RFC-294 S10): the package itself (contracts, semantics, schemas, codecs) lives in `application/employeeTypePackage.ts`;
// this file only adapts it to digital-employee's `EmployeeTypePackageRegistration` (JSON in, JSON out).

import type { EmployeeTypePackageRegistration } from '@/modules/digital-employee/public/types'
import {
  runtimePackage,
  type WorkContract,
  type ToolImplementation,
} from '../application/employeeTypePackage'
import { upgradeLegacyDevelopmentProgram } from '../application/legacyDevelopmentProgramUpgrade'

// Bootstrap's entry (RFC-294: bootstrap takes a module through its composition): the three values bootstrap wires into
// digital-employee and execution-contract. Module code and tests take them from `../application/employeeTypePackage`.
export {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
  developmentImplicitAgentContractDeclarations,
} from '../application/employeeTypePackage'

export const developmentEmployeeTypePackage: EmployeeTypePackageRegistration = {
  descriptorJson: JSON.stringify(runtimePackage.descriptor),
  parseWorkScopeJson(inputJson) {
    return JSON.stringify(runtimePackage.parseWorkScope(JSON.parse(inputJson) as unknown))
  },
  summarizeWorkScopeJson(scopeJson, locale) {
    return runtimePackage.summarizeWorkScope(JSON.parse(scopeJson) as unknown, locale)
  },
  validateContractFixtureJson(requestJson) {
    const request = JSON.parse(requestJson) as {
      readonly contract: WorkContract
      readonly implementation: ToolImplementation
    }
    return JSON.stringify(runtimePackage.validateContractFixture(request))
  },
  upgradeProgramSourceJson(requestJson) {
    const request = JSON.parse(requestJson) as Parameters<typeof upgradeLegacyDevelopmentProgram>[0]
    const upgraded = upgradeLegacyDevelopmentProgram(request)
    return upgraded === null ? null : JSON.stringify(upgraded)
  },
}
