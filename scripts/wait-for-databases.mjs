#!/usr/bin/env node
/**
 * 等待四个服务端测试目标可用。
 *
 * 为什么单独做这一步：GitHub Actions 的 service `--health-cmd` 只能证明「容器内
 * 服务进程起来了」，而 Oracle 的 PDB 在监听就绪之后还需要时间才能真正接受登录。
 * 直接开跑测试会在 CI 上偶发失败，且错误信息是测试内部的连接超时，看不出是环境
 * 问题。这里逐库重试并在超时后打印具体是哪个目标、什么错误。
 *
 *   node scripts/wait-for-databases.mjs            # 只等已配置 URL 的目标
 *   node scripts/wait-for-databases.mjs --require-all
 *
 * 环境变量与 test/server/support.ts 一致：
 *   GRM_PG_URL / GRM_MYSQL_URL / GRM_MSSQL_URL / GRM_ORACLE_URL
 *   WAIT_TIMEOUT_MS  单个目标的总超时，默认 180000
 */
import process from 'node:process'

const TARGETS = [
  { name: 'PostgreSQL', env: 'GRM_PG_URL', package: 'pg', connect: connectPg },
  { name: 'MySQL', env: 'GRM_MYSQL_URL', package: 'mysql2/promise', connect: connectMysql },
  { name: 'SQL Server', env: 'GRM_MSSQL_URL', package: 'mssql', connect: connectMssql },
  { name: 'Oracle', env: 'GRM_ORACLE_URL', package: 'oracledb', connect: connectOracle },
]

const requireAll = process.argv.includes('--require-all')
const timeoutMs = Number(process.env.WAIT_TIMEOUT_MS ?? 180_000)
const log = (message) => process.stdout.write(`${message}\n`)

async function connectPg(url) {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5_000 })
  try {
    await pool.query('select 1')
  } finally {
    await pool.end().catch(() => undefined)
  }
}

async function connectMysql(url) {
  const { default: mysql } = await import('mysql2/promise')
  const connection = await mysql.createConnection({ uri: url, connectTimeout: 5_000 })
  try {
    await connection.query('select 1')
  } finally {
    await connection.end().catch(() => undefined)
  }
}

async function connectMssql(url) {
  const { default: sql } = await import('mssql')
  const parsed = new URL(url)
  const pool = new sql.ConnectionPool({
    server: parsed.hostname,
    port: Number(parsed.port || 1433),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, '') || 'master',
    connectionTimeout: 5_000,
    options: { trustServerCertificate: true, encrypt: true },
  })
  try {
    await pool.connect()
    await pool.request().query('select 1')
  } finally {
    await pool.close().catch(() => undefined)
  }
}

async function connectOracle(url) {
  const { default: oracledb } = await import('oracledb')
  const parsed = new URL(url)
  const connection = await oracledb.getConnection({
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    connectString: `${parsed.hostname}:${parsed.port || 1521}/${parsed.pathname.replace(/^\//, '')}`,
  })
  try {
    await connection.execute('select 1 from dual')
  } finally {
    await connection.close().catch(() => undefined)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor({ name, env, package: driver, connect }) {
  const url = process.env[env]?.trim()
  if (!url) {
    if (requireAll) throw new Error(`${name}: ${env} is not set (--require-all)`)
    log(`  · ${name}: ${env} not set, skipped`)
    return
  }

  // Fail early with a clear message when the driver is not installed, instead of
  // surfacing a bare module-resolution error from inside the retry loop.
  try {
    await import(driver)
  } catch {
    throw new Error(`${name}: driver "${driver}" is not installed; run pnpm install`)
  }

  const started = Date.now()
  let attempt = 0
  let lastError
  while (Date.now() - started < timeoutMs) {
    attempt += 1
    try {
      await connect(url)
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      log(`  ✓ ${name}: ready after ${elapsed}s (${attempt} attempt(s))`)
      return
    } catch (error) {
      lastError = error
      await sleep(Math.min(1_000 + attempt * 500, 5_000))
    }
  }
  throw new Error(
    `${name}: not ready after ${timeoutMs}ms (${attempt} attempt(s)); last error: ${lastError?.message ?? 'unknown'}`,
  )
}

try {
  log(`waiting for server test targets (timeout ${timeoutMs}ms each)`)
  // Sequential on purpose: parallel attempts during Oracle's slow first start only
  // interleave noise into the log.
  for (const target of TARGETS) await waitFor(target)
  log('all configured targets are ready')
} catch (error) {
  process.stderr.write(`✗ ${error.message}\n`)
  process.exitCode = 1
}
