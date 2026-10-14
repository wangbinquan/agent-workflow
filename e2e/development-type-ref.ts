// The built-in development employee type as the production descriptor publishes
// it. The revision moves every time the built-in package is republished, so a
// hand-copied `development@N` turns a whole spec into `employee-type-not-found`
// 404s the day it changes (packages/backend/tests/e2e-development-type-ref.test.ts).
import { developmentEmployeeTypePackage } from '../packages/backend/src/modules/development-automation/composition/employeeTypePackage'

const { typeRef } = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
  readonly typeRef: { readonly typeId: string; readonly revision: number }
}

/** `development@<current revision>`. */
export const DEVELOPMENT_TYPE_REF = `${typeRef.typeId}@${typeRef.revision}`
/** The same reference as a URL path segment (`@` encoded). */
export const DEVELOPMENT_TYPE_PATH = `${typeRef.typeId}%40${typeRef.revision}`
