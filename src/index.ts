// Retain native interface merging in bundled declarations without runtime installation.
export type {} from './expression-extensions'
export { applyPatches } from './apply-patches'
export { enhanceClient } from './query-enhancer'
export { newSqlClient } from './client-factory'
export type {
  NativeClientOptions,
  SupportedDriver,
  DialectDriverMap,
  SourceDialect,
} from './client-factory'
export type {
  Dialect,
  DialectOptions,
  DialectProfile,
  ServerVersion,
  DialectCapabilities,
} from './dialect-context'
export type {
  EnhancedSqlClient,
  EnhancedMutableRootQuery,
  EnhancedMutableSubQuery,
  EnhancedMutableBaseQuery,
  QueryExtensions,
} from './query-enhancer'
export type { QueryFunctions } from './query-functions'
export type { PortableFunctions, NumericArgument } from './portable-functions'
export { getFunctionMetadata, QuerySemanticError } from './function-semantics'
export type { FunctionMetadata, FunctionKind } from './function-semantics'
export type { SqlFunctionDefinition, DialectFunctions } from './dialect-functions'
export type { SqlArgument, SqlResult } from './sql-function'
export { bool, nullableBool } from './bool'
export { isColumnDefaultExpression } from './defaults'
export { createGlobalFilterManager } from './global-filter'
export type { GlobalFilter, GlobalFilterManager } from './global-filter'
export type {
  ColumnDefaultExpression,
  ColumnDefaultLiteral,
  ColumnDefaultValue,
  ColumnPatchData,
  PatchedEntityProp,
} from './types'
