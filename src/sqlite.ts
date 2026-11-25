import { createDialectClientFactory, createDialectEnhancer } from './client-factory'
export const newSqlClient = createDialectClientFactory('sqlite')
export const enhanceClient = createDialectEnhancer('sqlite')
export type SqliteClient = import('./query-enhancer').EnhancedSqlClient<'sqlite'>
