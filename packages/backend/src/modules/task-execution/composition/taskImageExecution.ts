// RFC-414: the hosted task image's execution operations are infrastructure; bootstrap (which depends only on module
// composition / public) reaches them through this export.
export {
  TASK_IMAGE_EXECUTION_OPERATIONS,
  executeTaskImageExecutionOperation,
} from '../infrastructure/crewstation/taskImageExecution'
