// Retain native interface merging in bundled declarations without runtime installation.
export type {} from './expression-extensions'
import { createDialectClientFactory, createDialectEnhancer } from './client-factory'
export const newSqlClient = createDialectClientFactory('sqlserver')
export const enhanceClient = createDialectEnhancer('sqlserver')
export type SqlServerClient = import('./query-enhancer').EnhancedSqlClient<'sqlserver'>
