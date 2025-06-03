# Setup Mister.Version Action

Install and setup the Mister.Version CLI tool for semantic versioning in monorepos.

## Description

This action handles the installation and configuration of the Mister.Version CLI tool, ensuring it's available for subsequent versioning operations in your workflow. The tool is installed globally via `dotnet tool install`.

## Usage

```yaml
- uses: mr-version/setup@v1
  with:
    version: 'latest'
    dotnet-version: '8.0.x'
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `version` | Version of Mister.Version to install (latest, specific version like 1.0.0, or local path) | No | `latest` |
| `dotnet-version` | .NET SDK version to use | No | `8.0.x` |
| `cache` | Enable caching of the tool installation | No | `true` |
| `token` | GitHub token for downloading releases | No | `${{ github.token }}` |

## Outputs

| Output | Description |
|--------|-------------|
| `tool-path` | Path to the installed mr-version tool |
| `cache-hit` | Whether the tool was restored from cache |
| `version` | Actual version of the tool that was installed |

## Examples

### Basic Setup

```yaml
steps:
  - uses: actions/checkout@v4
  
  - uses: mr-version/setup@v1
```

### Specific Version

```yaml
steps:
  - uses: actions/checkout@v4
  
  - uses: mr-version/setup@v1
    with:
      version: '1.1.0-rc.12'  # Specific version
      dotnet-version: '8.0.x'
```

### Local Development

```yaml
steps:
  - uses: actions/checkout@v4
  
  - uses: mr-version/setup@v1
    with:
      version: './mister.version/nupkg/Mister.Version.CLI.1.1.0-rc.15.nupkg'
      cache: 'false'
```

### Matrix Build

```yaml
strategy:
  matrix:
    dotnet: ['6.0.x', '7.0.x', '8.0.x']
    
steps:
  - uses: actions/checkout@v4
  
  - uses: mr-version/setup@v1
    with:
      dotnet-version: ${{ matrix.dotnet }}
```

## Caching

The action automatically caches the tool installation to speed up subsequent runs. The cache key is based on:
- Operating system
- .NET SDK version
- Mister.Version tool version

To disable caching:

```yaml
- uses: mr-version/setup@v1
  with:
    cache: 'false'
```

## Version Resolution

The `version` input accepts:
- `latest` - Installs the latest stable release from NuGet
- `1.1.0` - Installs a specific version
- `1.1.0-rc.15` - Installs a prerelease version
- `./path/to/nupkg` - Uses a local NuGet package path (useful for testing)

## Prerequisites

This action requires:
- A GitHub-hosted or self-hosted runner
- Network access to GitHub releases (unless using local path)

## Troubleshooting

### Tool Not Found

If the tool isn't found after installation:
1. Check the `tool-path` output
2. Ensure the .NET SDK version is compatible
3. Verify network access to GitHub

### Cache Issues

To force a fresh installation:
```yaml
- uses: mr-version/setup@v1
  with:
    cache: 'false'
```

### Permission Errors

Ensure the runner has write permissions to the tool installation directory.

## License

This action is part of the Mister.Version project and is licensed under the MIT License.