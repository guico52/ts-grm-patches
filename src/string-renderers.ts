import { validateNativeStringIndexes } from './string-arguments'
import { err } from '@ts-grm/core'
import {
  PostgresDriver,
  MySqlDriver,
  SqliteDriver,
  SqlServerDriver,
  OracleDriver,
  sqlerr,
} from '@ts-grm/sql'
import { createStringFunctions } from './string-functions'
import { createPortableFunctions } from './portable-functions'
import { createDialectProfile, driverFamily } from './dialect-context'

// This boundary is verified against @ts-grm/sql 0.0.13. All output still flows
// through its NodeRenderContext, preserving native binding/precedence/scopes.
// @see https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/sql/src/driver/node_render.ts
type Context = {
  driverName: string
  text(value: string): void
  render(value: unknown): void
  separator(): void
  withPrecedence(value: number): Disposable
  withComposite(value: unknown): Disposable
}
type Render = (expr: object, ctx: Context) => void
type Operation = (ctx: Context, scopes: Disposable[]) => void
function stage(ctx: Context) {
  const operations: Operation[] = []
  const buffered: Context = {
    driverName: ctx.driverName,
    text: (value) => {
      operations.push((c) => c.text(value))
    },
    render: (value) => {
      operations.push((c) => c.render(value))
    },
    separator: () => {
      operations.push((c) => c.separator())
    },
    withPrecedence: (value) => scope((c) => c.withPrecedence(value)),
    withComposite: (value) => scope((c) => c.withComposite(value)),
  }
  function scope(enter: (c: Context) => Disposable): Disposable {
    operations.push((c, scopes) => {
      scopes.push(enter(c))
    })
    return {
      [Symbol.dispose]() {
        operations.push((_, scopes) => {
          scopes.pop()![Symbol.dispose]()
        })
      },
    }
  }
  return {
    buffered,
    replay() {
      const scopes: Disposable[] = []
      try {
        for (const op of operations) op(ctx, scopes)
      } finally {
        while (scopes.length) scopes.pop()![Symbol.dispose]()
      }
    },
  }
}
const patched = new WeakSet<object>()
const methods = [
  'Left',
  'Right',
  'Substring',
  'Position',
  'Pad',
  'Trim',
  'Length',
  'Reverse',
] as const
function repair(prototype: object) {
  if (patched.has(prototype)) return
  patched.add(prototype)
  for (const name of methods) {
    const key = `render${name}Expr`
    const original = Reflect.get(prototype, key) as Render
    if (typeof original !== 'function') continue
    Object.defineProperty(prototype, key, {
      configurable: true,
      writable: true,
      value(this: object, expression: object, ctx: Context) {
        validateNativeStringIndexes(name, expression)
        const family = driverFamily(ctx.driverName)
        const fallback = () => {
          const profile = createDialectProfile(family, ctx.driverName)
          const strings = createStringFunctions(profile)
          const read = (key: string) => Reflect.get(expression, key)
          let expr: unknown
          switch (name) {
            case 'Left':
              expr = strings.left(read('expr'), read('lenExpr'))
              break
            case 'Right':
              expr = strings.right(read('expr'), read('lenExpr'))
              break
            case 'Substring':
              expr = strings.substring(read('expr'), read('startExpr'), read('lenExpr'))
              break
            case 'Position':
              expr = strings.position(read('expr'), read('substrExpr'), read('startExpr'))
              break
            case 'Pad':
              expr = (read('side') === 'LEFT' ? strings.lpad : strings.rpad)(
                read('expr'),
                read('lenExpr'),
                read('padExpr'),
              )
              break
            case 'Trim':
              if (read('side') !== 'BOTH' && read('side') !== undefined)
                return original.call(this, expression, ctx)
              expr = strings.trim(read('expr'))
              break
            case 'Length':
              expr = createPortableFunctions(profile).charLength(read('expr'))
              break
            case 'Reverse':
              expr = strings.reverse(read('expr'))
              break
          }
          ctx.render(expr)
        }
        // Verified silent defects cannot be caught as exceptions. Keep these
        // repairs pinned to the current peer version; no final-SQL rewriting.
        const silent =
          name === 'Left' ||
          name === 'Right' ||
          name === 'Position' ||
          (family === 'sqlserver' && ['Substring', 'Pad', 'Trim'].includes(name)) ||
          (name === 'Length' && family !== 'sqlite' && family !== 'postgres') ||
          (name === 'Reverse' && family === 'oracle')
        if (silent) return fallback()
        const transaction = stage(ctx)
        try {
          original.call(this, expression, transaction.buffered)
        } catch (error) {
          // Arguments are only rendered on replay, so their errors cannot be
          // mistaken for an unsupported outer string operation.
          if (
            !(error instanceof sqlerr.UnsupportedFeatureError) &&
            !(error instanceof err.StateError && String(error.message).includes('does not support'))
          )
            throw error
          return fallback()
        }
        transaction.replay()
      },
    })
  }
}
let installed = false
export function installStringRenderers() {
  if (installed) return
  installed = true
  // No pool operation occurs: native driver renderers are created synchronously.
  for (const Driver of [PostgresDriver, MySqlDriver, SqliteDriver, SqlServerDriver, OracleDriver]) {
    const renderer = new Driver({}).nodeRender
    repair(Object.getPrototypeOf(renderer))
  }
}
