import * as core from '@actions/core'
import * as toolCache from '@actions/tool-cache'
import * as cache from '@actions/cache'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as path from 'path'
import * as fs from 'fs'

const TOOL_NAME = 'mister-version'

async function run(): Promise<void> {
  try {
    const version = core.getInput('version') || 'latest'
    const dotnetVersion = core.getInput('dotnet-version') || '8.0.x'
    const enableCache = core.getBooleanInput('cache')

    core.info(`Setting up Mister.Version CLI tool version: ${version}`)

    // Setup .NET first
    await setupDotNet(dotnetVersion)

    let toolPath: string | undefined = undefined;
    let cacheHit = false
    let actualVersion = version

    // Resolve version if 'latest'
    if (version === 'latest' || version === 'prerelease') {
      actualVersion = await getLatestVersion(version === 'prerelease')
      core.info(`Latest version resolved to: ${actualVersion}`)
    }

    // Check cache first
    if (enableCache) {
      const cacheKey = `${TOOL_NAME}-nuget-${actualVersion}-${process.platform}-${process.arch}`
      const cachePath = path.join(getCachePath(), `nuget-${actualVersion}`)
      const cachedPath = await cache.restoreCache([cachePath], cacheKey)
      if (cachedPath) {
        toolPath = cachePath
        cacheHit = true
        core.info(`Tool restored from cache`)
      }
    }

    if (!cacheHit) {
      // Download and install
      toolPath = await downloadAndInstall(actualVersion)

      // Save to cache
      if (enableCache) {
        const cacheKey = `${TOOL_NAME}-nuget-${actualVersion}-${process.platform}-${process.arch}`
        await cache.saveCache([toolPath], cacheKey)
        core.info(`Tool cached for future use`)
      }
    }

    if (toolPath === undefined) {
      throw new Error('mr-version tool path could not be located.');
    }

    // Add to PATH
    core.addPath(toolPath)
    core.info(`Added mr-version to PATH`)

    // Verify installation
    await verifyInstallation(toolPath)

    // Set outputs
    core.setOutput('tool-path', toolPath)
    core.setOutput('cache-hit', cacheHit.toString())
    core.setOutput('version', actualVersion)

    core.info(`✅ Mister.Version CLI tool setup complete! Version: ${actualVersion}`)
    
  } catch (error) {
    core.setFailed(`Failed to setup Mister.Version: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function setupDotNet(version: string): Promise<void> {
  // Check if .NET is already available
  try {
    const output = await exec.getExecOutput('dotnet', ['--version'], { silent: true })
    core.info(`.NET SDK is available: ${output.stdout.trim()}`)
    return
  } catch (error) {
    // .NET not available, will be set up by the workflow
    core.warning('.NET SDK not found. Ensure setup-dotnet action runs before this action.')
  }
}

async function getLatestVersion(includePrerelease: boolean): Promise<string> {
  try {
    // Use dotnet tool search to find the latest version
    const params = ['tool', 'search', 'Mister.Version.CLI', '--take', '1']
    if (includePrerelease) {
      params.push('--prerelease')
    }
    const output = await exec.getExecOutput('dotnet', params, { silent: true })
    
    if (output.exitCode !== 0) {
      throw new Error('Failed to fetch latest version from NuGet')
    }
    
    // Parse the output to extract version
    const lines = output.stdout.split('\n')
    for (const line of lines) {
      if (line.toLowerCase().includes('mister.version.cli')) {
        const parts = line.trim().split(/\s+/).filter(part => part.length > 0)
        
        const packageIndex = parts.findIndex(part => part.toLowerCase() === 'mister.version.cli')
        if (packageIndex >= 0 && packageIndex + 1 < parts.length) {
          const version = parts[packageIndex + 1]
          if (/^\d+\.\d+\.\d+/.test(version)) {
            return version
          }
        }
      }
    }
    
    throw new Error('Could not parse latest version from NuGet search results')
  } catch (error) {
    core.warning(`Failed to fetch latest version: ${error instanceof Error ? error.message : String(error)}`)
    
    // Fallback version for development/testing
    const fallbackVersion = '1.1.1'
    core.info(`Using fallback version: ${fallbackVersion}`)
    return fallbackVersion
  }
}

async function downloadAndInstall(version: string): Promise<string> {
  core.info(`Installing Mister.Version.CLI from NuGet`)
  return await installFromNuGet(version)
}

async function installFromNuGet(version: string): Promise<string> {
  // Create tool directory
  const toolDir = path.join(getCachePath(), `nuget-${version}`)
  await io.mkdirP(toolDir)

  // Install the tool
  const installArgs = [
    'tool', 'install',
    'Mister.Version.CLI',
    '--tool-path', toolDir
  ]

  // Add version if specified and not 'latest'
  if (version !== 'latest') {
    installArgs.push('--version', version)
  } else {
    installArgs.push('--prerelease')
  }

  try {
    const installOutput = await exec.getExecOutput('dotnet', installArgs)
    
    if (installOutput.exitCode !== 0) {
      throw new Error(`dotnet tool install failed with exit code ${installOutput.exitCode}`)
    }
  } catch (error) {
    // Check if error indicates package not found
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('could not be found') || 
        errorMessage.includes('No packages found') ||
        errorMessage.includes('Unable to find package')) {
      throw new Error('Package not available on NuGet.org. Please publish the package first.')
    }
    
    // Try to update instead
    const updateArgs = installArgs.map(arg => arg === 'install' ? 'update' : arg)
    const updateOutput = await exec.getExecOutput('dotnet', updateArgs)
    
    if (updateOutput.exitCode !== 0) {
      throw new Error(`Both install and update failed`)
    }
  }

  return toolDir
}

async function verifyInstallation(toolPath: string): Promise<void> {
  const toolExecutable = process.platform === 'win32'
    ? path.join(toolPath, 'mr-version.exe')
    : path.join(toolPath, 'mr-version')

  if (!fs.existsSync(toolExecutable)) {
    throw new Error(`Tool executable not found at: ${toolExecutable}`)
  }

  try {
    // Test the tool with --help command
    const output = await exec.getExecOutput(toolExecutable, ['--help'], { 
      silent: true,
      ignoreReturnCode: true 
    })
    
    if (output.exitCode === 0) {
      core.info('✅ Tool verification successful')
      return
    }
    
    throw new Error(`Tool verification failed with exit code ${output.exitCode}`)
  } catch (error) {
    // Try adding execute permissions on Unix systems
    if (process.platform !== 'win32') {
      try {
        await exec.exec('chmod', ['+x', toolExecutable])
        const retryOutput = await exec.getExecOutput(toolExecutable, ['--help'], { 
          silent: true,
          ignoreReturnCode: true 
        })
        if (retryOutput.exitCode === 0) {
          core.info('✅ Tool verification successful')
          return
        }
      } catch {
        // Ignore chmod errors
      }
    }
    
    core.error('Tool verification failed. Ensure actions/setup-dotnet@v4 runs before this action.')
    throw new Error(`Tool verification failed: ${error}`)
  }
}

function getCachePath(): string {
  const baseDir = process.env.RUNNER_TOOL_CACHE || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.mister-version-cache')
  return path.join(baseDir, TOOL_NAME)
}

// Run the action
if (require.main === module) {
  run()
}

export { run }