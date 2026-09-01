// RFC-345 compatibility facade. SQLite transaction-local MCP runtime-test
// lifecycle mechanics are owned by Resource Catalog infrastructure; existing
// cross-context writers retain this exact import until their provider-native
// lifecycle participants are injected by their successor owners.

export * from '@/modules/resource-catalog/infrastructure/legacy/mcpRuntimeTestTransitions'
