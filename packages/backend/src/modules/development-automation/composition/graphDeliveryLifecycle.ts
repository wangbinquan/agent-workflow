import type { EmployeeTypePackageRegistration } from '@/modules/digital-employee/public/types'
import {
  createGraphDeliveryLifecycleRuntimeCodec,
  createGraphDeliveryLifecycleTypePackage,
  type GraphDeliveryLifecycleRuntimeCodec,
} from '../application/graph-development/deliveryLifecycle'
import { developmentEmployeeTypePackage } from './employeeTypePackage'
export { GRAPH_DELIVERY_EMPLOYEE_TYPE } from '../application/graph-development/deliveryLifecycle'

/** graph@2 type package: the development package registration validates the non-graph contract fixtures. */
export function composeGraphDeliveryLifecycleTypePackage(
  core: EmployeeTypePackageRegistration,
): EmployeeTypePackageRegistration {
  return createGraphDeliveryLifecycleTypePackage(core, developmentEmployeeTypePackage)
}

export function composeGraphDeliveryLifecycleRuntimeCodec(
  core: GraphDeliveryLifecycleRuntimeCodec,
): GraphDeliveryLifecycleRuntimeCodec {
  return createGraphDeliveryLifecycleRuntimeCodec(core)
}
