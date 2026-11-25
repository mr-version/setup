# Setup Mister.Version Action

Install the Mister.Version CLI (`mr-version`) for semantic versioning in monorepos.

## Description

This action installs the [`Mister.Version.CLI`](https://www.nuget.org/packages/Mister.Version.CLI) .NET tool with
`dotnet tool install --tool-path` into the runner tool cache, adds it to `PATH`, and verifies that it starts.
It does **not** install .NET: run [`actions/setup-dotnet`](https://github.com/actions/setup-dotnet) first.

## Usage

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0            # mr-version needs the full history and tags

  - uses: actions/setup-dotnet@v4
    with:
      dotnet-version: '8.0.x'

  - uses: mr-version/setup@main
    with:
      version: 'latest'
```

### Which ref to use

The repository has a `v1` tag, but it points at the initial check-in (June 2025) and predates the fixes described
here (Node 24 runtime, working cache, DOTNET_ROOT handling). Until a new release tag is published, reference
`@main` or pin a commit SHA.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `version` | `latest` (newest stable), `prerelease` (newest including prereleases), a specific version such as `3.0.0`, or a path to a local `Mister.Version.CLI.<version>.nupkg` | No | `latest` |
| `cache` | Cache the installed tool with the GitHub Actions cache service | No | `true` |
| `dotnet-version` | **Deprecated, ignored.** This action never installed .NET; use `actions/setup-dotnet` | No | |

## Outputs

| Output | Description |
|--------|-------------|
| `tool-path` | Directory containing the `mr-version` executable (added to `PATH`) |
| `cache-hit` | `true` when the tool was restored from the cache (or was already present in the runner tool cache) |
| `version` | Version of `Mister.Version.CLI` that was installed |

## .NET requirements

- A .NET SDK must be on `PATH` (`dotnet tool install` and `dotnet tool search` need it). Use `actions/setup-dotnet`.
- The tool runs on the .NET 8 runtime. Builds of the CLI after 3.0.0 set `RollForward=Major`, so they also run when
  only a newer runtime (.NET 9, .NET 10, ...) is installed. Version 3.0.0 and earlier need a .NET 8 runtime; to run
  them on a newer runtime only, set `DOTNET_ROLL_FORWARD: Major` in the job environment.
- The installed `mr-version` shim finds .NET through `DOTNET_ROOT` or the operating system's default install
  location; it does not search `PATH`. `actions/setup-dotnet` sets `DOTNET_ROOT`. When it is not set (for example
  .NET installed into `~/.dotnet` on a self-hosted runner), this action derives the install directory from the
  `dotnet` on `PATH` and exports `DOTNET_ROOT` for the following steps.

## Examples

### Basic setup

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - uses: actions/setup-dotnet@v4
    with:
      dotnet-version: '8.0.x'
  - uses: mr-version/setup@main
  - run: mr-version report --output text
```

### Specific version

```yaml
  - uses: mr-version/setup@main
    with:
      version: '3.0.0'
```

### Newer .NET only

```yaml
  - uses: actions/setup-dotnet@v4
    with:
      dotnet-version: '10.0.x'
  - uses: mr-version/setup@main
    with:
      version: '3.0.0'
    env:
      DOTNET_ROLL_FORWARD: Major   # only needed for CLI versions without RollForward=Major (3.0.0 and earlier)
```

### Local package (testing a CLI build)

```yaml
  - run: dotnet pack mister.version/Mister.Version.CLI -c Release -o ./nupkg -p:PackageVersion=3.0.1-local.1
  - uses: mr-version/setup@main
    with:
      version: './nupkg/Mister.Version.CLI.3.0.1-local.1.nupkg'
```

The path is resolved against `GITHUB_WORKSPACE`. It may also point at a directory that contains exactly one
`Mister.Version.CLI.*.nupkg`. Local packages are never cached. Give local builds a version that is not published on
nuget.org: NuGet prefers its global packages folder over the local file when the version already exists there.

## Caching

With `cache: true` the tool directory is saved with the GitHub Actions cache service (`@actions/cache` 5.x, which
uses the current cache service) under the key `mister-version-nuget-<version>-<os>-<arch>`, and restored on later
runs. When the cache service is unavailable (GHES without caching, local runs) caching is skipped with a message.
A failed save is reported as a warning and never fails the step; "Tool cached for future use" is only logged when the
save succeeded.

On self-hosted runners the tool directory under `RUNNER_TOOL_CACHE` survives between jobs and is reused directly.

To always install fresh:

```yaml
  - uses: mr-version/setup@main
    with:
      cache: 'false'
```

## Errors

The step fails (instead of installing a different version) when:

- `dotnet` is not on `PATH`;
- `latest`/`prerelease` cannot be resolved because `dotnet tool search` fails (set `version` to a specific version
  to skip the lookup);
- the requested version does not exist on the configured NuGet feeds;
- `mr-version --help` does not run after installation (the error explains DOTNET_ROOT and runtime problems).

## License

This action is part of the Mister.Version project and is licensed under the MIT License.
