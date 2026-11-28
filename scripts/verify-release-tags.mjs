#!/usr/bin/env node
/**
 * 校验 git tag 与 npm 上真实发布的版本是否一一对应。
 *
 * 背景：本仓库的历史曾被重写，早期 tag 指向的 commit 脱离了 main。tag 记录的是
 * 当时发布的代码，因此这里同时核对三件事：
 *
 *   1. npm 上每个已发布版本都有同名 tag（反之 tag 也必须有对应版本）；
 *   2. tag 解析到的 commit 位于当前分支历史中（checkout 得出来、可维护）；
 *   3. 该 commit 的 package.json 版本号等于 tag 名。
 *
 * 另外把 tag 的树与 npm 记录的 `gitHead` 树做对比：若两者相同，说明 tag 指向的
 * 正是发布内容（只是 commit 因历史重写而换了身份）；这一步只告警，不判失败。
 *
 *   pnpm verify:tags             # 联网核对 npm registry
 *   pnpm verify:tags --local     # 离线：只检查 tag 可解析且位于当前分支
 *
 * 环境变量：
 *   NPM_REGISTRY       覆盖 registry，默认 https://registry.npmjs.org/
 *   IGNORED_VERSIONS   额外忽略的版本，逗号分隔
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const PACKAGE = 'ts-grm-patches'

/** 早于 0.1.0 的试验性发布，从未打算保留 tag。 */
const IGNORED_VERSIONS = new Set(['0.0.0-stage'])

/**
 * 发布时 package.json 尚未提交版本号的早期版本：tag 名与实际 version 必然不同。
 * 记录实际值，让例外是显式且可审计的，而不是默默放过。
 */
const LEGACY_VERSION_MISMATCH = new Map([
  ['0.2.0', '0.1.0'],
  ['0.2.1', '0.1.0'],
])

/** 发布准备会改动的文件：差异若未超出此集合，属正常的时序差异。 */
const RELEASE_METADATA_FILES = new Set([
  'package.json',
  'CHANGELOG.md',
  'README.md',
  'docs/zh-CN/README.md',
  'pnpm-lock.yaml',
  '.gitignore',
])

const localOnly = process.argv.includes('--local')
const registry = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org/').replace(/\/?$/, '/')

const extraIgnored = (process.env.IGNORED_VERSIONS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
for (const version of extraIgnored) IGNORED_VERSIONS.add(version)

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const short = (sha) => sha.slice(0, 7)
const normalise = (version) => version.replace(/^v/, '')

function tryGit(...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}

/** 本地 release tag：版本号 -> { name, commit, tree, version }。 */
function readLocalTags() {
  let names
  try {
    names = git('tag', '--list').split('\n').filter(Boolean)
  } catch {
    throw new Error('not a git repository, or git is unavailable')
  }

  const tags = new Map()
  for (const name of names) {
    if (!/^v?\d+\.\d+\.\d+/.test(name)) continue
    const commit = tryGit('rev-parse', '--verify', `${name}^{commit}`)
    if (!commit) throw new Error(`tag ${name} does not resolve to a commit`)
    const tree = git('rev-parse', `${commit}^{tree}`)
    const pkg = tryGit('show', `${commit}:package.json`)
    const version = pkg?.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null
    tags.set(normalise(name), { name, commit, tree, version })
  }
  return tags
}

async function readPublishedVersions() {
  const response = await fetch(`${registry}${PACKAGE}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`registry responded ${response.status} for ${registry}${PACKAGE}`)
  }
  const body = await response.json()
  return Object.entries(body.versions ?? {}).map(([version, manifest]) => ({
    version,
    gitHead: manifest?.gitHead ?? null,
  }))
}

const tags = readLocalTags()
const problems = []
const notes = []

/** `git merge-base --is-ancestor` 用退出码表达结果，成功时不输出。 */
function isAncestor(commit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function checkTagIsReachable(version, tag) {
  if (!isAncestor(tag.commit)) {
    problems.push(
      `v${version}: tag ${tag.name} -> ${short(tag.commit)} is not on the current branch`,
    )
  }
}

function checkTagVersion(version, tag) {
  const expected = LEGACY_VERSION_MISMATCH.get(version)
  if (tag.version === version) return
  if (expected !== undefined && tag.version === expected) {
    notes.push(`v${version}: package.json says ${tag.version} (legacy release, recorded exception)`)
    return
  }
  problems.push(
    `v${version}: tag ${tag.name} checks out package.json version ${tag.version ?? '<missing>'}`,
  )
}

/**
 * 与 npm 记录的 `gitHead` 对比。
 *
 * `gitHead` 是执行 `npm publish` 时的 HEAD，而本仓库历史上经常在提交版本号
 * **之前**就发布，所以它常是 release commit 的父提交。因此只有差异局限在发布
 * 元数据（package.json / CHANGELOG 等）时才算正常，其余代码差异视为失败。
 */
function checkTagMatchesGitHead(version, tag, gitHead) {
  if (!gitHead) return
  const headTree = tryGit('rev-parse', `${gitHead}^{tree}`)
  if (!headTree) {
    notes.push(
      `v${version}: npm gitHead ${short(gitHead)} is not present locally, tree check skipped`,
    )
    return
  }
  if (headTree === tag.tree) return

  const changed = tryGit('diff', '--name-only', gitHead, tag.commit)
  if (changed === null) {
    notes.push(`v${version}: cannot diff against npm gitHead ${short(gitHead)}, tree check skipped`)
    return
  }
  const files = changed.split('\n').filter(Boolean)
  const unexpected = files.filter((file) => !RELEASE_METADATA_FILES.has(file))
  if (unexpected.length === 0) {
    notes.push(
      `v${version}: npm gitHead ${short(gitHead)} predates the release commit (differs only in ${files.join(', ')})`,
    )
    return
  }
  problems.push(
    `v${version}: tag ${tag.name} differs from npm gitHead ${short(gitHead)} in ${unexpected.join(', ')}`,
  )
}

if (localOnly) {
  for (const [version, tag] of tags) {
    checkTagIsReachable(version, tag)
    checkTagVersion(version, tag)
  }
} else {
  const published = await readPublishedVersions()
  const expected = published.filter(({ version }) => !IGNORED_VERSIONS.has(version))
  const publishedNames = new Set(expected.map(({ version }) => version))

  for (const { version, gitHead } of expected) {
    const tag = tags.get(version)
    if (!tag) {
      problems.push(`v${version} is published on npm but has no tag`)
      continue
    }
    checkTagIsReachable(version, tag)
    checkTagVersion(version, tag)
    checkTagMatchesGitHead(version, tag, gitHead)
  }

  for (const [version, tag] of tags) {
    if (!publishedNames.has(version)) {
      problems.push(`tag ${tag.name} has no matching version on npm`)
    }
  }
}

for (const note of notes) process.stdout.write(`  · ${note}\n`)
for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`)

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} release-tag problem(s) found\n`)
  process.exitCode = 1
} else {
  const scope = localOnly ? 'local tags' : `published versions on ${registry}`
  process.stdout.write(`ok: ${tags.size} release tag(s) consistent with ${scope}\n`)
}
