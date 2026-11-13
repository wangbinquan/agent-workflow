export { selectLocalAgentMaterialDefinition } from '../infrastructure/local/localAgentMaterialDefinition'
export { bindNativeAgentMaterialWorkspace } from '../infrastructure/local/agentMaterialWorkspace'
// RFC-491: the native driver and the plugin-load failure judgment Task Execution's native runs receive as providers.
export { selectNativeRuntimeDriver } from '../infrastructure/local/nativeRuntimeDriver'
export { detectPluginLoadFailure } from '../infrastructure/local/pluginLoadDiagnostics'
