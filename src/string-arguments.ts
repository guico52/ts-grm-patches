import { dsl, spi } from '@ts-grm/core'

// LiteralNumExpr is not exported as a runtime SPI constructor in 0.0.13.
// Match native literal/constant prototypes without interpreting arbitrary expressions.
// @see https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/core/src/impl/ast/literal.ts
const literalNumberPrototype = Object.getPrototypeOf(
  Reflect.get(dsl.native.str`''`.substring(1), 'startExpr'),
) as object
const constantPrototype = Object.getPrototypeOf(dsl.constant(0)) as object
export function validateStringIndex(value: unknown, minimum: number): void {
  if (typeof value !== 'number' && !(value instanceof spi.AbstractNumExpr))
    throw new TypeError('String index/length requires a number or numeric expression')
  const literal =
    typeof value === 'number'
      ? value
      : Object.getPrototypeOf(value) === literalNumberPrototype ||
          Object.getPrototypeOf(value) === constantPrototype
        ? Reflect.get(value, 'value')
        : undefined
  if (literal !== undefined && (!Number.isSafeInteger(literal) || literal < minimum))
    throw new TypeError(`String index/length must be a safe integer >= ${minimum}`)
}
export function validateNativeStringIndexes(name: string, expression: object): void {
  const read = (key: string) => Reflect.get(expression, key)
  if (['Left', 'Right', 'Pad'].includes(name)) validateStringIndex(read('lenExpr'), 0)
  if (name === 'Substring') {
    validateStringIndex(read('startExpr'), 1)
    if (read('lenExpr') !== undefined) validateStringIndex(read('lenExpr'), 0)
  }
  if (name === 'Position' && read('startExpr') !== undefined)
    validateStringIndex(read('startExpr'), 1)
}
