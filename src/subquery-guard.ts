import type { spi } from '@ts-grm/core'
import { QuerySemanticError } from './function-semantics'

export function assertSubqueryPagination(value: object) {
  const marker = Reflect.get(value, '__type')
  if (
    typeof marker !== 'function' ||
    !(Reflect.apply(marker, value, []) as { subQueryLike?: boolean }).subQueryLike
  )
    return
  const options = Reflect.get(value, 'options') as Partial<spi.AtomQueryOptions> | undefined
  if ((options?.limit ?? -1) >= 0 || (options?.offset ?? 0) > 0) throw unsupported()
}
function unsupported() {
  return new QuerySemanticError(
    'UNSUPPORTED_SUBQUERY_PAGINATION',
    'Native ts-grm 0.0.13 does not render subquery LIMIT/OFFSET',
  )
}
