// RFC-345 compatibility facade. SQLite Agent persistence mechanics are owned
// by Resource Catalog infrastructure; cross-context callers retain this exact
// import until their provider-neutral query/participant successor is injected.

export * from '@/modules/resource-catalog/infrastructure/legacy/agent'
