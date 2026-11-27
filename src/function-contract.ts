import type { spi } from '@ts-grm/core'
import type { DialectProfile } from './dialect-context'
import type { SqlArgument } from './sql-function'

export const portableNode = Symbol('ts-grm-patches.portable-function')
export interface PortableContract extends spi.NativeExprContract {
  readonly [portableNode]: true
  readonly fnName: string
  readonly kind: 'scalar' | 'aggregate'
  readonly args: readonly SqlArgument[]
  validate(profile: DialectProfile): void
}
export function isPortableFunction(value: object): value is PortableContract {
  return portableNode in value
}
