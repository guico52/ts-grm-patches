import { createDialectClientFactory, createDialectEnhancer } from './client-factory'
export const newSqlClient = createDialectClientFactory('postgres')
export const enhanceClient = createDialectEnhancer('postgres')
export type PostgresClient = import('./query-enhancer').EnhancedSqlClient<'postgres'>
