import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as path from 'path'
import * as fs from 'fs'

const TOOL_NAME = 'mister-version'
const PACKAGE_ID = 'Mister.Version.CLI'
const PACKAGE_ID_LOWER = PACKAGE_ID.toLowerCase()

// Messages `dotnet tool install` / NuGet print when a package or version does not exist
// (wording differs between SDK versions).
const PACKAGE_NOT_FOUND_PATTERNS = [
  /is not found in NuGet feeds/i,
  /could not be found/i,
  /Unable to find package/i,
  /No packages? (?:were )?found/i,
  /\bNU1101\b/,
  /\bNU1102\b/
]

interface LocalPackage {
  source: string
  version: string
}

function getBool(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name).trim()
  if (raw === '') {
    return defaultValue
  }
  return core.getBooleanInput(name)
}

async function run(): Promise<void> {
  try {
    const versionInput = (core.getInput('version') || 'latest').trim()
    const enableCache = getBool('cache', true)

    if (core.getInput('dotnet-version').trim() !== '') {
      core.warning(
        "The 'dotnet-version' input is deprecated and ignored: this action does not install .NET. " +
          'Use actions/setup-dotnet before this action (see the README for the .NET runtime requirements).'
      )
    }

    core.info(`Setting up Mister.Version CLI tool version: ${versionInput}`)

    // .NET must already be installed (e.g. by actions/setup-dotnet)
    const dotnet = await locateDotNet()
    await ensureDotNetRoot(dotnet)

    // Resolve the version to install
    const localPackage = resolveLocalPackage(versionInput)
    let actualVersion: string
    if (localPackage) {
      actualVersion = localPackage.version
      core.info(`Installing from local package source ${localPackage.source} (version ${actualVersion})`)
    } else if (versionInput === 'latest' || versionInput === 'prerelease') {
      actualVersion = await getLatestVersion(dotnet, versionInput === 'prerelease')
      core.info(`'${versionInput}' resolved to version: ${actualVersion}`)
    } else {
      actualVersion = versionInput
    }

    const toolDir = path.join(getCachePath(), localPackage ? `local-${actualVersion}` : `nuget-${actualVersion}`)
    const cacheKey = `${TOOL_NAME}-nuget-${actualVersion}-${process.platform}-${process.arch}`
    // Local packages are never cached: the same version string can be rebuilt with different content.
    const useCache = enableCache && !localPackage && isCacheAvailable()
    let cacheHit = false

    if (!localPackage && isInstalled(toolDir)) {
      // Self-hosted runners keep RUNNER_TOOL_CACHE between jobs
      cacheHit = true
      core.info(`Tool already present in the runner tool cache: ${toolDir}`)
    } else if (useCache) {
      cacheHit = await restoreFromCache(toolDir, cacheKey)
    }

    if (!cacheHit) {
      await installTool(dotnet, toolDir, actualVersion, localPackage?.source)

      if (useCache) {
        await saveToCache(toolDir, cacheKey)
      }
    }

    // Add to PATH and verify
    core.addPath(toolDir)
    core.info(`Added ${toolDir} to PATH`)
    const banner = await verifyInstallation(toolDir)

    core.setOutput('tool-path', toolDir)
    core.setOutput('cache-hit', cacheHit.toString())
    core.setOutput('version', actualVersion)

    try {
      await core.summary
        .addHeading('🔧 Mister.Version Setup')
        .addDetails(
          '📦 Setup Details',
          `✅ **Tool installed successfully!**\n\n` +
            `- **Version**: \`${actualVersion}\`\n` +
            (banner ? `- **Tool Banner**: \`${banner}\`\n` : '') +
            `- **Tool Path**: \`${toolDir}\`\n` +
            `- **Cache Hit**: ${cacheHit ? '✅ Yes' : '❌ No'}\n` +
            `- **Platform**: ${process.platform} (${process.arch})\n` +
            `- **DOTNET_ROOT**: \`${process.env.DOTNET_ROOT || '(default location)'}\`\n\n` +
            `The mr-version tool is now available in your workflow.`
        )
        .write()
    } catch (error) {
      // The job summary is optional (e.g. unavailable on older GHES); the tool is installed
      core.debug(`Could not write the job summary: ${error instanceof Error ? error.message : String(error)}`)
    }

    core.info(`✅ Mister.Version CLI tool setup complete! Version: ${actualVersion}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await core.summary
        .addHeading('❌ Mister.Version Setup Failed')
        .addDetails('🐛 Error Details', `\`\`\`\n${message}\n\`\`\``)
        .write()
    } catch {
      // Summary is unavailable outside GitHub Actions; the failure below is what matters
    }

    core.setFailed(`Failed to setup Mister.Version: ${message}`)
  }
}

async function locateDotNet(): Promise<string> {
  const dotnet = await io.which('dotnet', false)
  if (!dotnet) {
    throw new Error(
      '.NET SDK not found on PATH. Add actions/setup-dotnet before this action.'
    )
  }
  const output = await exec.getExecOutput(dotnet, ['--version'], { silent: true, ignoreReturnCode: true })
  if (output.exitCode !== 0) {
    throw new Error(
      `'dotnet --version' failed (exit code ${output.exitCode}):\n${(output.stderr || output.stdout).trim()}\n` +
        'Add actions/setup-dotnet before this action.'
    )
  }
  core.info(`.NET SDK is available: ${output.stdout.trim()} (${dotnet})`)
  return dotnet
}

/**
 * The tool's apphost shim only finds .NET through DOTNET_ROOT or the OS default install
 * location; it does not search PATH. When dotnet lives elsewhere (e.g. ~/.dotnet) and
 * DOTNET_ROOT is unset, the shim exits with code 131. Export DOTNET_ROOT for this and later steps.
 */
async function ensureDotNetRoot(dotnet: string): Promise<void> {
  if (process.env.DOTNET_ROOT) {
    core.info(`DOTNET_ROOT is set: ${process.env.DOTNET_ROOT}`)
    return
  }

  const root = await deriveDotNetRoot(dotnet)
  if (!root) {
    core.warning(
      `Could not determine the .NET install directory from ${dotnet}; set DOTNET_ROOT if mr-version fails to start.`
    )
    return
  }

  core.exportVariable('DOTNET_ROOT', root)
  core.info(`DOTNET_ROOT was not set; exported DOTNET_ROOT=${root}`)
}

async function deriveDotNetRoot(dotnet: string): Promise<string | undefined> {
  // dotnet on PATH is often a symlink (e.g. /usr/bin/dotnet -> /usr/share/dotnet/dotnet)
  let resolved = dotnet
  try {
    resolved = fs.realpathSync(dotnet)
  } catch {
    // keep the unresolved path
  }
  const candidate = path.dirname(resolved)
  if (fs.existsSync(path.join(candidate, 'host', 'fxr'))) {
    return candidate
  }

  // Fall back to the runtime locations reported by dotnet itself:
  //   Microsoft.NETCore.App 8.0.11 [/root/.dotnet/shared/Microsoft.NETCore.App]
  const output = await exec.getExecOutput(dotnet, ['--list-runtimes'], { silent: true, ignoreReturnCode: true })
  if (output.exitCode === 0) {
    const match = output.stdout.match(/Microsoft\.NETCore\.App\s+\S+\s+\[(.+)\]/)
    if (match) {
      const root = path.dirname(path.dirname(match[1].trim()))
      if (fs.existsSync(root)) {
        return root
      }
    }
  }
  return undefined
}

/**
 * Supports installing from a local package: a path to a Mister.Version.CLI.<version>.nupkg file,
 * or to a directory that contains exactly one such package.
 */
function resolveLocalPackage(versionInput: string): LocalPackage | undefined {
  const looksLikePath =
    versionInput.toLowerCase().endsWith('.nupkg') ||
    versionInput.includes('/') ||
    versionInput.includes('\\')
  if (!looksLikePath) {
    return undefined
  }

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  const fullPath = path.resolve(workspace, versionInput)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Local package path not found: ${fullPath}`)
  }

  const packagePattern = new RegExp(`^${PACKAGE_ID.replace(/\./g, '\\.')}\\.(\\d+\\.\\d+\\.\\d+.*)\\.nupkg$`, 'i')

  if (fs.statSync(fullPath).isDirectory()) {
    const packages = fs.readdirSync(fullPath).filter(f => packagePattern.test(f))
    if (packages.length !== 1) {
      throw new Error(
        `Expected exactly one ${PACKAGE_ID}.<version>.nupkg in ${fullPath}, found ${packages.length}. ` +
          'Point the version input at the .nupkg file instead.'
      )
    }
    const match = packages[0].match(packagePattern)
    return { source: fullPath, version: (match as RegExpMatchArray)[1] }
  }

  const match = path.basename(fullPath).match(packagePattern)
  if (!match) {
    throw new Error(`Local package file name must look like ${PACKAGE_ID}.<version>.nupkg: ${fullPath}`)
  }
  return { source: path.dirname(fullPath), version: match[1] }
}

async function getLatestVersion(dotnet: string, includePrerelease: boolean): Promise<string> {
  const params = ['tool', 'search', PACKAGE_ID, '--take', '1']
  if (includePrerelease) {
    params.push('--prerelease')
  }
  const output = await exec.getExecOutput(dotnet, params, { silent: true, ignoreReturnCode: true })

  if (output.exitCode !== 0) {
    throw new Error(
      `Could not resolve the ${includePrerelease ? 'latest prerelease' : 'latest'} version of ${PACKAGE_ID}: ` +
        `'dotnet ${params.join(' ')}' failed with exit code ${output.exitCode}:\n${(output.stderr || output.stdout).trim()}\n` +
        "Set the 'version' input to a specific version to avoid the lookup."
    )
  }

  // Output is a table: "Package ID   Latest Version   Authors   Downloads   Verified"
  for (const line of output.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    const packageIndex = parts.findIndex(part => part.toLowerCase() === PACKAGE_ID_LOWER)
    if (packageIndex >= 0 && packageIndex + 1 < parts.length) {
      const version = parts[packageIndex + 1]
      if (/^\d+\.\d+\.\d+/.test(version)) {
        return version
      }
    }
  }

  throw new Error(
    `Could not parse the latest version of ${PACKAGE_ID} from 'dotnet tool search' output:\n${output.stdout.trim()}\n` +
      "Set the 'version' input to a specific version to avoid the lookup."
  )
}

function getExecutablePath(toolDir: string): string {
  return path.join(toolDir, process.platform === 'win32' ? 'mr-version.exe' : 'mr-version')
}

function isInstalled(toolDir: string): boolean {
  return fs.existsSync(getExecutablePath(toolDir)) && fs.existsSync(path.join(toolDir, '.store', PACKAGE_ID_LOWER))
}

function isCacheAvailable(): boolean {
  try {
    if (cache.isFeatureAvailable()) {
      return true
    }
  } catch {
    // fall through
  }
  core.info('The GitHub Actions cache service is not available on this runner; caching is skipped.')
  return false
}

async function restoreFromCache(toolDir: string, cacheKey: string): Promise<boolean> {
  try {
    const restoredKey = await cache.restoreCache([toolDir], cacheKey)
    if (restoredKey && isInstalled(toolDir)) {
      core.info(`Tool restored from cache (key: ${restoredKey})`)
      return true
    }
    core.info(`No cache entry found for key: ${cacheKey}`)
  } catch (error) {
    core.warning(`Failed to restore tool from cache: ${error instanceof Error ? error.message : String(error)}`)
  }
  return false
}

async function saveToCache(toolDir: string, cacheKey: string): Promise<void> {
  try {
    const cacheId = await cache.saveCache([toolDir], cacheKey)
    if (cacheId !== -1) {
      core.info(`Tool cached for future use (key: ${cacheKey})`)
    } else {
      core.info('Tool was not saved to the cache (see messages above); it will be reinstalled on the next run.')
    }
  } catch (error) {
    core.warning(`Failed to save tool to cache: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function installTool(dotnet: string, toolDir: string, version: string, source?: string): Promise<void> {
  core.info(`Installing ${PACKAGE_ID} ${version} into ${toolDir}`)

  // Start from a clean directory so a partial install cannot be mistaken for a complete one
  await io.rmRF(toolDir)
  await io.mkdirP(toolDir)

  const installArgs = ['tool', 'install', PACKAGE_ID, '--tool-path', toolDir, '--version', version]
  if (source) {
    installArgs.push('--add-source', source)
  }

  const output = await exec.getExecOutput(dotnet, installArgs, { ignoreReturnCode: true })
  if (output.exitCode === 0) {
    return
  }
  await io.rmRF(toolDir)

  const details = `${output.stdout}\n${output.stderr}`.trim()
  if (PACKAGE_NOT_FOUND_PATTERNS.some(pattern => pattern.test(details))) {
    throw new Error(
      `${PACKAGE_ID} version '${version}' was not found on the configured NuGet feeds. ` +
        `Check the 'version' input (published versions: https://www.nuget.org/packages/${PACKAGE_ID}).\n${details}`
    )
  }
  throw new Error(`'dotnet ${installArgs.join(' ')}' failed with exit code ${output.exitCode}:\n${details}`)
}

/** Runs `mr-version --help` and returns the first line of its output (e.g. "mr-version 3.0.0+sha"). */
async function verifyInstallation(toolDir: string): Promise<string> {
  const toolExecutable = getExecutablePath(toolDir)

  if (!fs.existsSync(toolExecutable)) {
    throw new Error(`Tool executable not found at: ${toolExecutable}`)
  }

  const runHelp = async (): Promise<exec.ExecOutput> =>
    exec.getExecOutput(toolExecutable, ['--help'], { silent: true, ignoreReturnCode: true })

  let output: exec.ExecOutput
  try {
    output = await runHelp()
  } catch (error) {
    if (process.platform === 'win32') {
      throw error
    }
    // The executable bit can be lost when a cache is restored
    await exec.exec('chmod', ['+x', toolExecutable], { silent: true, ignoreReturnCode: true })
    output = await runHelp()
  }

  if (output.exitCode === 0) {
    const banner = output.stdout.split('\n')[0].trim()
    core.info(`✅ Tool verification successful${banner ? `: ${banner}` : ''}`)
    return banner
  }

  const details = `${output.stdout}\n${output.stderr}`.trim()
  let hint = ''
  if (output.exitCode === 131 || /You must install \.NET/i.test(details)) {
    hint =
      '\nThe mr-version shim could not locate .NET. Set DOTNET_ROOT to the .NET install directory ' +
      '(actions/setup-dotnet does this for you).'
  } else if (/framework.*was not found|You must install or update \.NET/i.test(details)) {
    hint =
      '\nNo compatible .NET runtime was found. Install a .NET 8 runtime with actions/setup-dotnet ' +
      "(dotnet-version: '8.0.x'), or set DOTNET_ROLL_FORWARD=Major to run this tool version on a newer runtime."
  }
  throw new Error(`Tool verification failed: 'mr-version --help' exited with code ${output.exitCode}.${hint}\n${details}`)
}

function getCachePath(): string {
  const baseDir =
    process.env.RUNNER_TOOL_CACHE ||
    path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.mister-version-cache')
  return path.join(baseDir, TOOL_NAME)
}

// Run the action
if (require.main === module) {
  run()
}

export { run }
