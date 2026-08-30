import { createHash } from 'node:crypto'
import { lstatSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, open, opendir, readlink, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { runFileTree } from './process.js'

const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const
const MAX_DEPENDENCY_FILES = 500_000
const MAX_DEPENDENCY_BYTES = 8 * 1024 * 1024 * 1024

export type WorktreeDependencyInspection =
  | { status: 'local'; lockfile: string }
  | { status: 'copyable'; lockfile: string; sourceModules: string }
  | { status: 'installable'; lockfile: string; reason: string }
  | { status: 'unavailable'; reason: string }

export type WorktreeDependencyProvision =
  | { status: 'local'; lockfile: string }
  | { status: 'copied'; lockfile: string; materializedBy: 'trusted-copy' | 'npm-ci' }
  | { status: 'unavailable'; reason: string }

export interface WorktreeDependencyProvisionOptions {
  stagingRoot: string
  signal?: AbortSignal
  installNpm?: (installRoot: string, cacheRoot: string, signal?: AbortSignal) => Promise<void>
  /** Test-only lower entry ceiling; production always uses MAX_DEPENDENCY_FILES. */
  maxDependencyFiles?: number
}

interface NpmInstallPlan {
  packagePaths: string[]
  binNames: Set<string>
}

function sameMetadataFile(left: string, right: string, binary = false): boolean {
  const leftBody = readFileSync(left)
  const rightBody = readFileSync(right)
  if (binary) return leftBody.equals(rightBody)
  return leftBody.toString('utf8').replaceAll('\r\n', '\n') === rightBody.toString('utf8').replaceAll('\r\n', '\n')
}

function existingLockfiles(root: string): string[] {
  return LOCKFILES.filter(name => existsSync(join(root, name)))
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function normalizedDependencyPath(path: string): string | undefined {
  if (!path.startsWith('node_modules/') || path.includes('\\') || path.split('/').includes('..')) return undefined
  const normalized = path.replaceAll('/', sep)
  return !isAbsolute(normalized) && inside('node_modules', normalized) ? normalized : undefined
}

function packageDirectories(modulesRoot: string): string[] | undefined {
  const found: string[] = []
  const queue: Array<{ directory: string; depth: number }> = [{ directory: modulesRoot, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth > 64 || found.length > 100_000) return undefined
    if (!existsSync(current.directory)) continue
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      if (entry.name === '.bin') continue
      if (entry.name.startsWith('.')) {
        if (current.directory === modulesRoot && entry.name === '.package-lock.json' && entry.isFile()) continue
        return undefined
      }
      const path = join(current.directory, entry.name)
      if (entry.isSymbolicLink()) return undefined
      if (entry.name.startsWith('@')) {
        if (!entry.isDirectory()) return undefined
        for (const scoped of readdirSync(path, { withFileTypes: true })) {
          if (scoped.name.startsWith('.')) return undefined
          if (!scoped.isDirectory() || scoped.isSymbolicLink()) return undefined
          const packagePath = join(path, scoped.name)
          found.push(packagePath)
          queue.push({ directory: join(packagePath, 'node_modules'), depth: current.depth + 1 })
        }
      } else {
        if (!entry.isDirectory()) return undefined
        found.push(path)
        queue.push({ directory: join(path, 'node_modules'), depth: current.depth + 1 })
      }
    }
  }
  return found
}

function packageBinNames(lockMetadata: unknown, packageRoot: string): string[] {
  if (!lockMetadata || typeof lockMetadata !== 'object' || Array.isArray(lockMetadata)) return []
  const bin = (lockMetadata as { bin?: unknown }).bin
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    return Object.keys(bin).filter(name => /^[a-z0-9._-]+$/iu.test(name))
  }
  if (typeof bin === 'string') {
    try {
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown }
      if (typeof manifest.name === 'string') return [manifest.name.split('/').at(-1)!]
    } catch { /* an invalid package cannot justify its string-form bin shim */ }
  }
  return []
}

function installableNpmLock(root: string, lockfile: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown }
    if (manifest.workspaces !== undefined) return 'npm workspaces require an explicit repository setup recipe'
    const lock = JSON.parse(readFileSync(join(root, lockfile), 'utf8')) as { packages?: Record<string, unknown> }
    const packages = lock.packages ?? {}
    const verified = new Set<string>()
    const verifying = new Set<string>()
    const verifyPackage = (path: string): string | undefined => {
      if (verified.has(path)) return undefined
      if (verifying.has(path)) return `${path} has a cyclic bundled-dependency authority chain`
      const value = packages[path]
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} has invalid lock metadata`
      const metadata = value as {
        version?: unknown; resolved?: unknown; integrity?: unknown; link?: unknown; inBundle?: unknown
        bundleDependencies?: unknown; bundledDependencies?: unknown
      }
      if (metadata.link === true) return `${path} is a linked dependency`
      if (typeof metadata.version !== 'string') return `${path} is not pinned by version`
      verifying.add(path)
      try {
        if (metadata.inBundle === true) {
          const marker = path.lastIndexOf('/node_modules/')
          if (marker < 0) return `${path} is bundled without a parent package`
          const parentPath = path.slice(0, marker)
          const childName = path.slice(marker + '/node_modules/'.length)
          const parent = packages[parentPath]
          if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return `${path} has no lock-recorded bundle parent`
          const parentMetadata = parent as { bundleDependencies?: unknown; bundledDependencies?: unknown }
          const bundled = parentMetadata.bundleDependencies ?? parentMetadata.bundledDependencies
          if (!Array.isArray(bundled) || !bundled.every(name => typeof name === 'string') || !bundled.includes(childName)) {
            return `${path} is not declared by its bundle parent`
          }
          const parentFailure = verifyPackage(parentPath)
          if (parentFailure) return parentFailure
        } else {
          if (typeof metadata.resolved !== 'string' || typeof metadata.integrity !== 'string') {
            return `${path} is not pinned by HTTPS origin and integrity`
          }
          let origin: URL
          try { origin = new URL(metadata.resolved) } catch { return `${path} has an invalid resolved origin` }
          if (origin.protocol !== 'https:' || origin.username || origin.password) return `${path} has a non-HTTPS or credential-bearing origin`
          if (!/^sha(?:256|384|512)-[a-z0-9+/]+={0,2}$/iu.test(metadata.integrity)) return `${path} has an unsupported integrity digest`
        }
        verified.add(path)
        return undefined
      } finally {
        verifying.delete(path)
      }
    }
    for (const path of Object.keys(packages)) {
      if (!path.startsWith('node_modules/')) continue
      const failure = verifyPackage(path)
      if (failure) return failure
    }
    return undefined
  } catch {
    return `${lockfile} cannot be parsed for safe npm materialization`
  }
}

function lockEntryMatches(expected: unknown, installed: unknown): boolean {
  if (!expected || !installed || typeof expected !== 'object' || typeof installed !== 'object'
    || Array.isArray(expected) || Array.isArray(installed)) return false
  const wanted = expected as Record<string, unknown>
  const actual = installed as Record<string, unknown>
  return ['version', 'resolved', 'integrity', 'link'].every(key => wanted[key] === undefined || isDeepStrictEqual(wanted[key], actual[key]))
}

function npmInstallPlan(metadataRoot: string, modulesRoot: string, lockfile: string, containmentRoot = metadataRoot): NpmInstallPlan | undefined {
  const receiptPath = join(modulesRoot, '.package-lock.json')
  if (!existsSync(receiptPath) || !existsSync(modulesRoot)) return undefined
  try {
    const modulesMetadata = lstatSync(modulesRoot)
    const canonicalModules = realpathSync(modulesRoot)
    if (!modulesMetadata.isDirectory() || modulesMetadata.isSymbolicLink() || !inside(realpathSync(containmentRoot), canonicalModules)) return undefined
    const expected = JSON.parse(readFileSync(join(metadataRoot, lockfile), 'utf8')) as { lockfileVersion?: unknown; packages?: unknown }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { lockfileVersion?: unknown; packages?: unknown }
    if (expected.lockfileVersion !== receipt.lockfileVersion || !expected.packages || !receipt.packages
      || typeof expected.packages !== 'object' || typeof receipt.packages !== 'object'
      || Array.isArray(expected.packages) || Array.isArray(receipt.packages)) return undefined
    const wantedEntries = Object.entries(expected.packages).filter(([path]) => path.startsWith('node_modules/'))
    const installedEntries = Object.entries(receipt.packages).filter(([path]) => path.startsWith('node_modules/'))
    if (wantedEntries.length === 0 || installedEntries.length === 0) return undefined
    const wanted = Object.fromEntries(wantedEntries)
    const installed = Object.fromEntries(installedEntries)
    const packagePaths: string[] = []
    const binNames = new Set<string>()
    const receiptMtime = statSync(receiptPath).mtimeMs
    for (const [path, metadata] of installedEntries) {
      const normalized = normalizedDependencyPath(path)
      if (!normalized || !Object.hasOwn(wanted, path) || !lockEntryMatches(wanted[path], metadata)) return undefined
      const packageRoot = resolve(metadataRoot, normalized)
      const modulesPackageRoot = resolve(modulesRoot, relative(join(metadataRoot, 'node_modules'), packageRoot))
      if (!inside(canonicalModules, realpathSync(modulesPackageRoot))) return undefined
      const packageMetadata = lstatSync(modulesPackageRoot)
      if (!packageMetadata.isDirectory() || packageMetadata.isSymbolicLink() || packageMetadata.mtimeMs > receiptMtime) return undefined
      packagePaths.push(relative(modulesRoot, modulesPackageRoot))
      for (const name of packageBinNames(metadata, modulesPackageRoot)) binNames.add(name)
    }
    for (const [path, metadata] of wantedEntries) {
      if (Object.hasOwn(installed, path)) continue
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || (metadata as { optional?: unknown }).optional !== true) return undefined
    }
    const physicalPackages = packageDirectories(modulesRoot)
    if (!physicalPackages) return undefined
    const actual = physicalPackages.map(path => relative(modulesRoot, path)).sort()
    if (!isDeepStrictEqual([...packagePaths].sort(), actual)) return undefined
    const binRoot = join(modulesRoot, '.bin')
    if (binNames.size === 0) {
      if (existsSync(binRoot) && (!lstatSync(binRoot).isDirectory() || lstatSync(binRoot).isSymbolicLink() || readdirSync(binRoot).length > 0)) return undefined
    } else {
      if (!existsSync(binRoot) || !lstatSync(binRoot).isDirectory() || lstatSync(binRoot).isSymbolicLink()) return undefined
      const actualBins = readdirSync(binRoot, { withFileTypes: true })
      const observed = new Set<string>()
      if (actualBins.length === 0 || actualBins.some(entry => {
        const logical = entry.name.replace(/\.(?:cmd|ps1)$/iu, '')
        observed.add(logical)
        return !binNames.has(logical) || (!entry.isFile() && !entry.isSymbolicLink())
      }) || [...binNames].some(name => !observed.has(name))) return undefined
    }
    return { packagePaths, binNames }
  } catch {
    return undefined
  }
}

function allowedCopyPath(relativePath: string, packagePaths: readonly string[]): boolean {
  if (relativePath === '' || relativePath === '.package-lock.json' || relativePath === '.bin' || relativePath.startsWith(`.bin${sep}`)) return true
  return packagePaths.some(path => relativePath === path || relativePath.startsWith(`${path}${sep}`) || path.startsWith(`${relativePath}${sep}`))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('dependency hydration canceled')
}

async function stableFileDigest(path: string): Promise<{ digest: string; size: number; mode: number }> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink > 1) throw new Error(`dependency tree contains a hardlinked or non-regular file: ${path}`)
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`dependency file changed while being read: ${path}`)
    }
    return { digest: hash.digest('hex'), size: after.size, mode: after.mode }
  } finally {
    await handle.close()
  }
}

async function dependencyPayloadManifest(
  root: string,
  plan: NpmInstallPlan,
  signal?: AbortSignal,
  digestFiles = true,
  maxFiles = MAX_DEPENDENCY_FILES,
): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [['', 'directory']]
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  let files = 1
  let bytes = 0
  while (queue.length > 0) {
    throwIfAborted(signal)
    const directory = queue.pop()!
    const depth = directory.depth + 1
    const processBatch = async (batch: Array<{ path: string; relativePath: string }>): Promise<void> => {
      const inspected = await Promise.all(batch.map(async child => {
        const metadata = await lstat(child.path)
        if (metadata.isSymbolicLink()) {
          const target = await realpath(child.path)
          if (!inside(root, target)) throw new Error(`dependency tree link escapes its root: ${child.relativePath}`)
          return { ...child, metadata, link: await readlink(child.path), value: undefined }
        }
        if (metadata.isFile()) {
          if (metadata.nlink > 1) throw new Error(`dependency tree contains a hardlinked or non-regular file: ${child.path}`)
          return { ...child, metadata, link: undefined, value: digestFiles ? await stableFileDigest(child.path) : undefined }
        }
        return { ...child, metadata, link: undefined, value: undefined }
      }))
      for (const child of inspected) {
        throwIfAborted(signal)
        if (child.metadata.isSymbolicLink()) {
          entries.push([child.relativePath, `link:${child.link!}`])
        } else if (child.metadata.isDirectory()) {
          entries.push([child.relativePath, 'directory'])
          queue.push({ path: child.path, depth })
        } else if (child.metadata.isFile()) {
          const size = child.value?.size ?? child.metadata.size
          const mode = child.value?.mode ?? child.metadata.mode
          bytes += size
          if (bytes > MAX_DEPENDENCY_BYTES) throw new Error('dependency tree exceeds hydration byte limit')
          entries.push([child.relativePath, digestFiles
            ? `file:${size}:${mode}:${child.value!.digest}`
            : `file:${size}:${mode}`])
        } else {
          throw new Error(`dependency tree contains an unsupported filesystem entry: ${child.relativePath}`)
        }
      }
    }
    let batch: Array<{ path: string; relativePath: string }> = []
    const handle = await opendir(directory.path)
    for await (const entry of handle) {
      const path = join(directory.path, entry.name)
      const relativePath = relative(root, path)
      if (!allowedCopyPath(relativePath, plan.packagePaths)) continue
      files += 1
      if (files > maxFiles) throw new Error('dependency tree exceeds hydration file limit')
      if (depth > 128) throw new Error('dependency tree exceeds hydration depth limit')
      batch.push({ path, relativePath })
      if (batch.length === 64) {
        await processBatch(batch)
        batch = []
      }
    }
    if (batch.length > 0) await processBatch(batch)
  }
  return entries.sort(([left], [right]) => left.localeCompare(right))
}

/** Prove whether one worktree already has, or can receive, an isolated npm dependency tree. */
export function inspectWorktreeDependencies(repoRoot: string, worktree: string): WorktreeDependencyInspection {
  const sourceRoot = realpathSync(repoRoot)
  const workerRoot = realpathSync(worktree)
  if (sourceRoot === workerRoot) return { status: 'unavailable', reason: 'source checkout and worktree must differ' }

  const workerPackage = join(workerRoot, 'package.json')
  if (!existsSync(workerPackage)) return { status: 'unavailable', reason: 'worktree package.json is missing' }
  try {
    const manifest = JSON.parse(readFileSync(workerPackage, 'utf8')) as unknown
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid manifest')
  } catch {
    return { status: 'unavailable', reason: 'worktree package.json is invalid' }
  }
  const workerLocks = existingLockfiles(workerRoot)
  if (workerLocks.length !== 1) return { status: 'unavailable', reason: 'automatic dependency hydration requires one unambiguous lockfile' }
  const lockfile = workerLocks[0]!
  if (!['npm-shrinkwrap.json', 'package-lock.json'].includes(lockfile)) {
    return { status: 'unavailable', reason: 'automatic dependency hydration currently requires an npm lockfile' }
  }
  try {
    const lock = JSON.parse(readFileSync(join(workerRoot, lockfile), 'utf8')) as { lockfileVersion?: unknown; packages?: unknown }
    if (typeof lock.lockfileVersion !== 'number' || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error('invalid lock')
  } catch {
    return { status: 'unavailable', reason: `worktree ${lockfile} is invalid` }
  }

  const targetModules = join(workerRoot, 'node_modules')
  if (existsSync(targetModules)) {
    return npmInstallPlan(workerRoot, targetModules, lockfile)
      ? { status: 'local', lockfile }
      : { status: 'unavailable', reason: 'worktree node_modules exists but is not a physical npm tree matching its lockfile' }
  }

  const sourcePackage = join(sourceRoot, 'package.json')
  const sourceLocks = existingLockfiles(sourceRoot)
  const matchingSourceMetadata = existsSync(sourcePackage)
    && sameMetadataFile(sourcePackage, workerPackage)
    && sourceLocks.length === 1
    && sourceLocks[0] === lockfile
    && sameMetadataFile(join(sourceRoot, lockfile), join(workerRoot, lockfile))
  const sourceModules = join(sourceRoot, 'node_modules')
  if (matchingSourceMetadata && npmInstallPlan(sourceRoot, sourceModules, lockfile)) {
    return { status: 'copyable', lockfile, sourceModules: realpathSync(sourceModules) }
  }
  const unsafeLock = installableNpmLock(workerRoot, lockfile)
  if (unsafeLock) return { status: 'unavailable', reason: `npm lock cannot be materialized automatically: ${unsafeLock}` }
  return {
    status: 'installable', lockfile,
    reason: matchingSourceMetadata
      ? 'source node_modules does not match its npm lock receipt'
      : 'source metadata differs from the authenticated worktree lock',
  }
}

async function assertStagingQuota(root: string, maxFiles = MAX_DEPENDENCY_FILES): Promise<void> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  let entries = 1
  let bytes = 0
  while (queue.length > 0) {
    const directory = queue.pop()!
    const processBatch = async (batch: Array<{ path: string; depth: number }>): Promise<void> => {
      const inspected = await Promise.all(batch.map(async child => {
        try { return { ...child, metadata: await lstat(child.path) } } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      }))
      for (const child of inspected) {
        if (!child) continue
        if (child.metadata.isFile()) {
          bytes += child.metadata.size
          if (bytes > MAX_DEPENDENCY_BYTES) throw new Error('npm staging exceeds dependency byte limit')
        } else if (child.metadata.isDirectory()) {
          queue.push({ path: child.path, depth: child.depth })
        }
      }
    }
    let handle
    try { handle = await opendir(directory.path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let batch: Array<{ path: string; depth: number }> = []
    for await (const entry of handle) {
      entries += 1
      if (entries > maxFiles) throw new Error('npm staging exceeds dependency file limit')
      const depth = directory.depth + 1
      if (depth > 128) throw new Error('npm staging exceeds dependency depth limit')
      batch.push({ path: join(directory.path, entry.name), depth })
      if (batch.length === 128) {
        await processBatch(batch)
        batch = []
      }
    }
    if (batch.length > 0) await processBatch(batch)
  }
}

async function installNpmFromLock(installRoot: string, cacheRoot: string, signal?: AbortSignal, maxFiles = MAX_DEPENDENCY_FILES): Promise<void> {
  const userConfig = join(installRoot, '.leppy-user.npmrc')
  const globalConfig = join(installRoot, '.leppy-global.npmrc')
  await writeFile(userConfig, '; isolated Leppy npm user config\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await writeFile(globalConfig, '; isolated Leppy npm global config\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const allowedEnvironment = new Set([
    'path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'comspec', 'home', 'userprofile',
    'appdata', 'localappdata', 'lang', 'lc_all', 'node_options', 'node_extra_ca_certs', 'ssl_cert_file',
    'https_proxy', 'http_proxy', 'no_proxy',
  ])
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name, value]) => value !== undefined && allowedEnvironment.has(name.toLowerCase())))
  environment.npm_config_cache = cacheRoot
  environment.npm_config_userconfig = userConfig
  environment.npm_config_globalconfig = globalConfig
  const npmArguments = [
    'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--offline=false', '--prefer-online', '--loglevel=error',
    `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
  ]
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) throw new Error(`npm CLI is unavailable beside the Host Node executable: ${npmCli}`)

  const operation = new AbortController()
  const abort = (): void => operation.abort(signal?.reason ?? new Error('dependency materialization canceled'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let quotaFailure: Error | undefined
  let quotaScan: Promise<void> | undefined
  const checkQuota = (): Promise<void> => {
    if (quotaScan) return quotaScan
    quotaScan = assertStagingQuota(dirname(installRoot), maxFiles).catch(error => {
      quotaFailure = error instanceof Error ? error : new Error(String(error))
      operation.abort(quotaFailure)
    }).finally(() => { quotaScan = undefined })
    return quotaScan
  }
  await checkQuota()
  const quotaTimer = setInterval(() => { void checkQuota() }, 5_000)
  try {
    const result = await runFileTree(process.execPath, [npmCli, ...npmArguments], {
      cwd: installRoot, env: environment, timeoutMs: 10 * 60_000, signal: operation.signal,
    })
    await checkQuota()
    if (quotaFailure) throw quotaFailure
    throwIfAborted(signal)
    if (result.exitCode !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').slice(-16 * 1024)
      throw new Error(`npm ci dependency materialization failed with exit ${result.exitCode}${detail ? `: ${detail}` : ''}`)
    }
  } finally {
    clearInterval(quotaTimer)
    signal?.removeEventListener('abort', abort)
  }
}

async function publishDependencyTreeNoReplace(stagingModules: string, targetModules: string): Promise<void> {
  if (process.platform === 'win32') {
    if (existsSync(targetModules)) throw new Error('worktree node_modules appeared before atomic hydration publish')
    await rename(stagingModules, targetModules)
    return
  }
  await mkdir(targetModules, { recursive: false })
  try {
    await cp(stagingModules, targetModules, {
      recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
      force: false, errorOnExist: true,
    })
    await rm(stagingModules, { recursive: true, force: true })
  } catch (error) {
    throw new Error(`exclusive dependency publication failed; partial controller-owned target was retained: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Materialize a validated npm tree in private staging and publish without replacing a target. */
export async function provisionWorktreeDependencies(
  repoRoot: string,
  worktree: string,
  options: WorktreeDependencyProvisionOptions,
): Promise<WorktreeDependencyProvision> {
  const maxFiles = options.maxDependencyFiles ?? MAX_DEPENDENCY_FILES
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_DEPENDENCY_FILES) throw new Error('invalid dependency entry limit')
  const inspection = inspectWorktreeDependencies(repoRoot, worktree)
  if (inspection.status === 'local') {
    const workerRoot = realpathSync(worktree)
    const modulesRoot = join(workerRoot, 'node_modules')
    const plan = npmInstallPlan(workerRoot, modulesRoot, inspection.lockfile)
    if (!plan) throw new Error('local npm dependency receipt changed before readiness validation')
    await dependencyPayloadManifest(modulesRoot, plan, options.signal, false, maxFiles)
    return inspection
  }
  if (inspection.status === 'unavailable') return inspection
  const workerRoot = realpathSync(worktree)
  const targetModules = join(workerRoot, 'node_modules')
  if (existsSync(targetModules)) return { status: 'unavailable', reason: 'worktree node_modules appeared before hydration' }

  const stagingRoot = resolve(options.stagingRoot)
  const stagingModules = join(stagingRoot, 'node_modules')
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  try {
    if (inspection.status === 'copyable') {
      const plan = npmInstallPlan(realpathSync(repoRoot), inspection.sourceModules, inspection.lockfile)
      if (!plan) throw new Error('source npm dependency receipt changed before hydration')
      const sourceManifest = await dependencyPayloadManifest(inspection.sourceModules, plan, options.signal, true, maxFiles)
      await cp(inspection.sourceModules, stagingModules, {
        recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
        force: false, errorOnExist: true,
        filter: source => {
          throwIfAborted(options.signal)
          return allowedCopyPath(relative(inspection.sourceModules, source), plan.packagePaths)
        },
      })
      throwIfAborted(options.signal)
      const stagedManifest = await dependencyPayloadManifest(stagingModules, plan, options.signal, true, maxFiles)
      if (!isDeepStrictEqual(sourceManifest, stagedManifest)) throw new Error('dependency payload changed during hydration')
      const receiptTime = new Date(Date.now() + 2_000)
      await utimes(join(stagingModules, '.package-lock.json'), receiptTime, receiptTime)
    } else {
      const installRoot = join(stagingRoot, 'install')
      const cacheRoot = join(stagingRoot, 'npm-cache')
      await mkdir(installRoot, { recursive: true })
      await cp(join(workerRoot, 'package.json'), join(installRoot, 'package.json'), { force: false, errorOnExist: true })
      await cp(join(workerRoot, inspection.lockfile), join(installRoot, inspection.lockfile), { force: false, errorOnExist: true })
      if (options.installNpm) await options.installNpm(installRoot, cacheRoot, options.signal)
      else await installNpmFromLock(installRoot, cacheRoot, options.signal, maxFiles)
      throwIfAborted(options.signal)
      const installedModules = join(installRoot, 'node_modules')
      const receiptTime = new Date(Date.now() + 2_000)
      await utimes(join(installedModules, '.package-lock.json'), receiptTime, receiptTime)
      const plan = npmInstallPlan(installRoot, installedModules, inspection.lockfile, stagingRoot)
      if (!plan) throw new Error('npm ci produced a dependency tree that does not match the authenticated lock')
      await dependencyPayloadManifest(installedModules, plan, options.signal, false, maxFiles)
      await rename(installedModules, stagingModules)
    }
    if (!npmInstallPlan(workerRoot, stagingModules, inspection.lockfile, stagingRoot)) throw new Error('staged dependency tree failed npm lock receipt verification')
    await publishDependencyTreeNoReplace(stagingModules, targetModules)
    await rm(stagingRoot, { recursive: true, force: true })
    const publishedPlan = npmInstallPlan(workerRoot, targetModules, inspection.lockfile)
    if (!publishedPlan) throw new Error('published dependency tree failed npm lock receipt verification')
    await dependencyPayloadManifest(targetModules, publishedPlan, options.signal, false, maxFiles)
    return {
      status: 'copied', lockfile: inspection.lockfile,
      materializedBy: inspection.status === 'copyable' ? 'trusted-copy' : 'npm-ci',
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export function dependencyCacheMiss(detail: string | undefined): boolean {
  return typeof detail === 'string' && /\bENOTCACHED\b/iu.test(detail) && /only-if-cached/iu.test(detail)
}

export function dependencyResolutionMiss(detail: string | undefined): boolean {
  return dependencyCacheMiss(detail)
    || (typeof detail === 'string' && /\bMODULE_NOT_FOUND\b/iu.test(detail) && /node_modules[\\/]/iu.test(detail))
}

export function dependencyHydrationAvailable(input: { repoRoot: string; worktree: string; dependencyBridgeActive?: boolean }): boolean {
  try {
    const status = inspectWorktreeDependencies(input.repoRoot, input.worktree).status
    return status === 'copyable' || status === 'installable'
  } catch {
    return false
  }
}

export function dependencyBridgeRecoveryAvailable(input: { repoRoot: string; worktree: string; detail?: string; dependencyBridgeActive?: boolean }): boolean {
  return dependencyResolutionMiss(input.detail) && dependencyHydrationAvailable(input)
}
