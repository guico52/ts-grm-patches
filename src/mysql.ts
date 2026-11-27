// Retain native interface merging in bundled declarations without runtime installation.
export type {} from './expression-extensions'
import { createDialectClientFactory, createDialectEnhancer } from './client-factory'
export const newSqlClient = createDialectClientFactory('mysql')
export const enhanceClient = createDialectEnhancer('mysql')
export type MySqlClient = import('./query-enhancer').EnhancedSqlClient<'mysql'>
