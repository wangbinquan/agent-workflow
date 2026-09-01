// Compatibility export; the SQLite overview read model lives in System Operations.
export * from '@/platform/persistence/sqlite/systemOverviewReadModel'
export { composeSystemOverviewQuery } from '@/modules/system-operations/application/overview'
export type {
  SystemOverviewAuthority,
  SystemOverviewQuery,
  TaskOverviewQuery,
} from '@/modules/system-operations/public/queries'
