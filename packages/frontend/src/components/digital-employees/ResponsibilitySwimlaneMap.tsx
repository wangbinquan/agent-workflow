/**
 * Compatibility boundary for extensions that still import the pre-panorama name.
 * New digital employee pages must use EmployeeCapabilityPanorama directly.
 */
export * from './EmployeeCapabilityPanorama'
export { EmployeeCapabilityPanorama as ResponsibilitySwimlaneMap } from './EmployeeCapabilityPanorama'
