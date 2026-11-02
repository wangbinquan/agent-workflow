// RFC-423: the recovery consumer selection contracts live in infrastructure/taskRecoverySelection.ts (the hosted
// recovery selection implements them there); bootstrap keeps reading the deployment selection from this entry.
export type { TaskRecoveryDeploymentSelection } from '../infrastructure/taskRecoverySelection'
