import { createDialectClientFactory, createDialectEnhancer } from './client-factory'
export const newSqlClient = createDialectClientFactory('sqlserver')
export const enhanceClient = createDialectEnhancer('sqlserver')
export type SqlServerClient = import('./query-enhancer').EnhancedSqlClient<'sqlserver'>
