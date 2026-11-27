import { createDialectProfile, resolveDriverFamily } from './dialect-context'
import type { DialectProfile } from './dialect-context'

const defaults = new WeakMap<object, DialectProfile>()

/** Resolve through the actual native client, including unenhanced clients. */
export function renderProfile(client: object): DialectProfile {
  const driver = Reflect.get(client, 'driver') as { name: string }
  const profile = Reflect.get(client, 'dialectProfile') as DialectProfile | undefined
  const family = resolveDriverFamily(driver)
  if (profile && profile.family === family && profile.driverName === driver.name) return profile
  let fallback = defaults.get(driver)
  if (!fallback || fallback.family !== family || fallback.driverName !== driver.name) {
    fallback = createDialectProfile(family, driver.name)
    defaults.set(driver, fallback)
  }
  return fallback
}
