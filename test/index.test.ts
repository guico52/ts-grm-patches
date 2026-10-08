import { describe, expect, it } from 'vitest'

import { PACKAGE_NAME } from '../src/index'

describe('package skeleton', () => {
  it('exposes the package name placeholder', () => {
    expect(PACKAGE_NAME).toBe('ts-grm-patches')
  })
})
