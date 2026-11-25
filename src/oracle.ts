import { createDialectClientFactory, createDialectEnhancer } from './client-factory'
export const newSqlClient = createDialectClientFactory('oracle')
export const enhanceClient = createDialectEnhancer('oracle')
export type OracleClient = import('./query-enhancer').EnhancedSqlClient<'oracle'>
