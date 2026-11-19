import type { EmployeeCaseDetailProjectionParticipant } from '@/modules/digital-employee/public/types'
import type { DevelopmentEmployeeCaseWorkspaceDetailReader } from '../application/employeeWorkspace'
import { createDevelopmentEmployeeCaseDetailProjection } from '../application/employeeCaseDetailProjection'
export { projectDevelopmentEmployeeCaseDetail } from '../application/employeeCaseDetailProjection'

export function composeDevelopmentEmployeeCaseDetailProjection(
  workspaces: DevelopmentEmployeeCaseWorkspaceDetailReader,
): EmployeeCaseDetailProjectionParticipant {
  return createDevelopmentEmployeeCaseDetailProjection(workspaces)
}
