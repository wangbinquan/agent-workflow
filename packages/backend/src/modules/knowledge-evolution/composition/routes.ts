// RFC-474: knowledge-evolution's HTTP bindings live in this module's inbound layer (RFC-353 T8 / T9); the application root
// (`server.ts`) mounts them through this entry, the same shape as code-capability's (RFC-439). It only re-exports, so
// `composition.ts` stays the schema-only root RFC-395 reviewed.
export { mountFusionRoutes } from '../inbound/fusionRoutes'
export { mountSkillProvenanceRoutes } from '../inbound/skillProvenanceRoutes'
