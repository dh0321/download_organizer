<#
.SYNOPSIS
  Installs the AI Asset Saver Local Agent's Native Messaging registration.

.DESCRIPTION
  Per Chrome's Native Messaging protocol, Chrome itself launches the Agent
  process on demand for each connectNative() call and terminates it when the
  port disconnects — there is no persistent background service or Startup-folder
  entry to register. Installation is exactly two steps:
    1. Write a native-messaging-host manifest JSON pointing at the Agent .exe,
       with allowed_origins locked to this specific Extension ID (PLAN.md §F-2).
    2. Point an HKCU registry key at that manifest.
  This script must be run on the actual target Windows machine — it cannot be
  meaningfully tested on macOS (PLAN.md appendix).

.PARAMETER ExtensionId
  The production Chrome Extension ID (from chrome://extensions after loading /
  publishing it). Required. Must be the standard 32-lowercase-letter (a-p)
  Chrome extension ID shape — validated up front so a typo/paste error fails
  clearly here instead of surfacing later as a confusing "REJECTED connection"
  in the Agent's log.

.PARAMETER AgentExePath
  Path to the packaged AIAssetSaverAgent.exe. Defaults to a sibling of this
  script named AIAssetSaverAgent.exe. Always resolved to an absolute path
  before being written into the manifest — Chrome's native-messaging host
  manifest requires an absolute "path"; a relative one is silently invalid.

.PARAMETER DefaultRoot
  Optional initial Default Root (e.g. "D:\AI_Projects"). If omitted, the Agent
  starts unconfigured and the user must set it from the Extension popup/options
  before any file is routed (fail-closed — PLAN.md §M).

  Re-running this script (e.g. because the unpacked extension got reloaded and
  received a new Extension ID — see README) with -DefaultRoot set again only
  ever updates defaultRoot/allowedExtensionId in an existing config.json;
  every other setting (folderTemplate, assetBuckets, conflictPolicy,
  maxConcurrentFileOps) is read back and preserved as-is, never reset to
  defaults. A brand-new config.json is only fully seeded with defaults the
  first time (when no config.json exists yet).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [string]$AgentExePath = (Join-Path $PSScriptRoot "AIAssetSaverAgent.exe"),

  [string]$DefaultRoot = ""
)

$ErrorActionPreference = "Stop"

if ($ExtensionId -notmatch "^[a-p]{32}$") {
  throw "ExtensionId '$ExtensionId' doesn't look like a real Chrome extension ID (expected exactly 32 lowercase letters a-p). Copy it from chrome://extensions again."
}

if (-not (Test-Path $AgentExePath)) {
  throw "Agent executable not found at '$AgentExePath'. Build it first (see apps/agent's pkg build step)."
}
# Chrome's native-messaging manifest requires an absolute "path" — resolve
# whatever was passed (default or custom, possibly relative) once, up front.
$AgentExePath = (Resolve-Path $AgentExePath).Path

$manifestDir = Join-Path $env:APPDATA "AIAssetSaver"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null

$manifestPath = Join-Path $manifestDir "com.ai_asset_saver.agent.json"
$manifest = @{
  name             = "com.ai_asset_saver.agent"
  description      = "AI Asset Saver Local Agent"
  path             = $AgentExePath
  type             = "stdio"
  allowed_origins  = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8

$registryKeyPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ai_asset_saver.agent"
New-Item -Path $registryKeyPath -Force | Out-Null
Set-ItemProperty -Path $registryKeyPath -Name "(default)" -Value $manifestPath

# Seed (or update) config.json so the Agent isn't ROOT_NOT_CONFIGURED on first
# launch, if the installer was given a Default Root up front.
if ($DefaultRoot -ne "") {
  $configPath = Join-Path $manifestDir "config.json"
  if (Test-Path $configPath) {
    # Re-running the installer (e.g. the extension got reloaded and received a
    # new ID) must never reset settings the user already customized from the
    # Extension's Settings UI — only the two fields the installer actually
    # owns are touched (allowedExtensionId can never be set any other way;
    # see agentConfig.ts's applySyncSettings).
    try {
      $existing = Get-Content $configPath -Raw | ConvertFrom-Json
    } catch {
      throw "Existing config.json at '$configPath' isn't valid JSON, so it can't be safely updated in place. Back it up, delete it, and re-run this script to reseed defaults. ($($_.Exception.Message))"
    }
    $existing.defaultRoot = $DefaultRoot
    $existing.allowedExtensionId = $ExtensionId
    $existing | ConvertTo-Json -Depth 6 | Set-Content -Path $configPath -Encoding UTF8
    Write-Host "Updated existing config.json: defaultRoot + allowedExtensionId only (folderTemplate/assetBuckets/conflictPolicy/maxConcurrentFileOps left untouched)."
  } else {
    $config = @{
      defaultRoot           = $DefaultRoot
      folderTemplate        = @{
        id     = "default"
        name   = "Project / Sequence"
        levels = @(
          @{ key = "project"; label = "Project"; order = 0; required = $false }
          @{ key = "sequence"; label = "Sequence"; order = 1; required = $false }
        )
      }
      assetBuckets          = @(
        @{ id = "generated"; label = "Generated"; order = 0 }
        @{ id = "reference"; label = "Reference"; order = 1 }
        @{ id = "character"; label = "Character"; order = 2 }
        @{ id = "environment"; label = "Environment"; order = 3 }
        @{ id = "prop"; label = "Prop"; order = 4 }
        @{ id = "turntable"; label = "Turntable"; order = 5 }
        @{ id = "concept"; label = "Concept"; order = 6 }
        @{ id = "final"; label = "Final"; order = 7 }
      )
      conflictPolicy        = "uniquify"
      maxConcurrentFileOps  = 2
      allowedExtensionId    = $ExtensionId
    }
    $config | ConvertTo-Json -Depth 6 | Set-Content -Path $configPath -Encoding UTF8
    Write-Host "Seeded new config.json with defaults."
  }
}

Write-Host "AI Asset Saver Agent registered for extension chrome-extension://$ExtensionId/"
Write-Host "Native messaging manifest: $manifestPath"
Write-Host "No background service or Startup entry was installed (none is needed — see script header)."
