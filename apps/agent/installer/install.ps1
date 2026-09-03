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
  publishing it). Required.

.PARAMETER AgentExePath
  Path to the packaged AIAssetSaverAgent.exe. Defaults to a sibling of this
  script named AIAssetSaverAgent.exe.

.PARAMETER DefaultRoot
  Optional initial Default Root (e.g. "D:\AI_Projects"). If omitted, the Agent
  starts unconfigured and the user must set it from the Extension popup/options
  before any file is routed (fail-closed — PLAN.md §M).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [string]$AgentExePath = (Join-Path $PSScriptRoot "AIAssetSaverAgent.exe"),

  [string]$DefaultRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AgentExePath)) {
  throw "Agent executable not found at '$AgentExePath'. Build it first (see apps/agent's pkg build step)."
}

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

# Seed AgentConfig.json so the Agent isn't ROOT_NOT_CONFIGURED on first launch,
# if the installer was given a Default Root up front.
if ($DefaultRoot -ne "") {
  $configPath = Join-Path $manifestDir "config.json"
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
}

Write-Host "AI Asset Saver Agent registered for extension chrome-extension://$ExtensionId/"
Write-Host "Native messaging manifest: $manifestPath"
Write-Host "No background service or Startup entry was installed (none is needed — see script header)."
