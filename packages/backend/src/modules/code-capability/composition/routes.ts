// RFC-439: code-capability's HTTP bindings live in this module's inbound/http;
// the application root (`server.ts`) mounts them through this entry. It only
// re-exports, so `composition.ts` stays the schema-only root RFC-395 reviewed.
export { mountCodeRoutes, type CodeHistoryRouteQueries } from '../inbound/http/codeRoutes'
export {
  mountCapabilityTemplateRoutes,
  type CapabilityTemplateRouteDeps,
} from '../inbound/http/capabilityTemplateRoutes'
