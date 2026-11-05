// RFC-448 — the two process-wide resource operation coordinators (moved from
// services/resourceOperationCoordinator.ts). Every MCP / plugin write, probe and
// diagnostic in this daemon linearizes through the same instance.
import { ResourceOperationCoordinator } from '../infrastructure/resourceOperationCoordinator'

/** Shared single-daemon instances, keyed by resource family then stable id. */
export const mcpOperationCoordinator = new ResourceOperationCoordinator()
export const pluginOperationCoordinator = new ResourceOperationCoordinator()
