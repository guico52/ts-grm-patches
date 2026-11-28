import process from 'node:process'

/**
 * 服务端真实执行测试的公共开关。
 *
 * 这些测试需要一个真实数据库。默认在未配置连接串时跳过，但**不静默**：
 * 与 `node:sqlite` 那条测试一样，跳过会打印原因；设置 `REQUIRE_SERVER_TESTS=1`
 * （CI 里会设）后，缺少任一目标直接失败，避免「有服务端验证」的声明悄悄失效。
 */
export const REQUIRE_SERVER_TESTS = process.env.REQUIRE_SERVER_TESTS === '1'

export function serverTarget(envVar: string): string | undefined {
  const value = process.env[envVar]
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 在 `describe.skipIf()` 之外单独调用一次，把「为什么跳过」讲清楚。
 * @returns 该目标是否应当跳过
 */
export function skipServer(name: string, envVar: string): boolean {
  if (serverTarget(envVar) !== undefined) return false
  const message = `[server] skipped ${name} execution test: ${envVar} is not set`
  if (REQUIRE_SERVER_TESTS) {
    throw new Error(
      `${message}\nREQUIRE_SERVER_TESTS=1 requires every server target to be configured.`,
    )
  }
  console.warn(message)
  return true
}

/** 按某个数值键稳定排序，避免依赖数据库的返回顺序。 */
export function sortBy<T>(rows: readonly T[], key: (row: T) => number | string): T[] {
  return [...rows].sort((left, right) => {
    const a = key(left)
    const b = key(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}
