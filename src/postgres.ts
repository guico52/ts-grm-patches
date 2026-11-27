// Retain native interface merging in bundled declarations without runtime installation.
export type {} from './expression-extensions'
import { createDialectClientFactory, createDialectEnhancer } from './client-factory'
export const newSqlClient = createDialectClientFactory('postgres')
export const enhanceClient = createDialectEnhancer('postgres')
export type PostgresClient = import('./query-enhancer').EnhancedSqlClient<'postgres'>
