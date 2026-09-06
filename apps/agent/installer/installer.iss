; Inno Setup script for the Download Organizer Local Agent.
;
; Builds on the same design as install.ps1/install.sh (see those files'
; headers for the shared rationale — Chrome launches the Agent per Native
; Messaging connection; there is no background service to install), but
; targets a non-technical end user double-clicking one file instead of a
; developer running a script with -ExtensionId.
;
; This only works because the Chrome extension's manifest.json pins a fixed
; "key" (see apps/extension/public/manifest.json) — that makes the resulting
; Chrome extension ID identical on every machine regardless of install path,
; so the ID below can be hardcoded instead of asked at install time. If that
; signing key is ever regenerated, EXTENSION_ID below must be recomputed to
; match (see the project's signing-key notes for how).
;
; Must be compiled on Windows (or a windows-latest CI runner — see
; .github/workflows/package-windows.yml). Requires dist-bundle\
; DownloadOrganizerAgent.exe to already exist (run `npm run bundle` then
; `npm run package:win` in apps/agent first).

#define ExtensionId "nhkfhokcdflcocakncaedcogpgemmbbj"
#define NativeHostName "com.download_organizer.agent"

[Setup]
AppName=Download Organizer Agent
AppVersion=0.1.8
AppPublisher=Download Organizer
DefaultDirName={userappdata}\DownloadOrganizer\bin
DisableDirPage=yes
DisableProgramGroupPage=yes
; No admin rights needed — everything below only touches HKCU and the
; current user's own %APPDATA%, same design intent as install.ps1.
PrivilegesRequired=lowest
OutputDir=..\dist-bundle
OutputBaseFilename=DownloadOrganizerSetup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
; NOT restartreplace: tried that as a "just in case it's still locked"
; backstop, but confirmed live it made things worse — restartreplace
; unconditionally defers the copy to next reboot regardless of whether the
; file is actually in use, so the .exe never updated at all without a
; manual restart. The taskkill in ssInstall below is what actually needs to
; work; ignoreversion alone is enough once nothing has the file open.
Source: "..\dist-bundle\DownloadOrganizerAgent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Code]
var
  DefaultRootPage: TInputDirWizardPage;

procedure InitializeWizard;
begin
  DefaultRootPage := CreateInputDirPage(wpSelectDir,
    'Default Root Folder', 'Where should organized files be saved?',
    'Download Organizer will create Project/Sequence/Category folders under ' +
    'this location. You can change this later from the extension''s popup ' +
    'if you skip it now.',
    False, '');
  DefaultRootPage.Add('');
  DefaultRootPage.Values[0] := ExpandConstant('{userdocs}\DownloadOrganizer');
end;

function ConfigDir(): String;
begin
  Result := ExpandConstant('{userappdata}\DownloadOrganizer');
end;

// Escapes a Windows path for embedding inside a JSON string literal —
// backslashes must be doubled (JSON has no other path-specific escaping
// needs here since these are always plain filesystem paths). StringChange
// mutates its first (var) argument and returns a replacement count, not a
// string, so a local copy is needed to turn it back into a function result.
function JsonEscapePath(Path: String): String;
var
  Escaped: String;
begin
  Escaped := Path;
  StringChange(Escaped, '\', '\\');
  Result := Escaped;
end;

procedure WriteNativeMessagingManifest(ExePath: String);
var
  ManifestPath, Json: String;
begin
  ManifestPath := ConfigDir() + '\{#NativeHostName}.json';
  Json :=
    '{' + #13#10 +
    '  "name": "{#NativeHostName}",' + #13#10 +
    '  "description": "Download Organizer Local Agent",' + #13#10 +
    '  "path": "' + JsonEscapePath(ExePath) + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": ["chrome-extension://{#ExtensionId}/"]' + #13#10 +
    '}';
  SaveStringToFile(ManifestPath, Json, False);

  RegWriteStringValue(HKCU, 'Software\Google\Chrome\NativeMessagingHosts\{#NativeHostName}',
    '', ManifestPath);
end;

// Mirrors install.ps1/install.sh's own safety fix: never overwrite an
// existing config.json (which may hold settings the user already customized
// from the extension's Settings page) — only seed one if none exists yet.
// Unlike those dev-facing scripts, there's no "allowedExtensionId changed,
// please update it" case to handle here at all, since the pinned manifest
// key makes the ID identical on every install — so skipping entirely when
// the file exists is fully safe, not just a simplification.
procedure SeedConfigIfMissing(DefaultRoot: String);
var
  ConfigPath, Json: String;
begin
  ConfigPath := ConfigDir() + '\config.json';
  if FileExists(ConfigPath) then
  begin
    Log('config.json already exists — leaving existing settings untouched.');
    exit;
  end;

  Json :=
    '{' + #13#10 +
    '  "defaultRoot": "' + JsonEscapePath(DefaultRoot) + '",' + #13#10 +
    '  "folderTemplate": {' + #13#10 +
    '    "id": "default",' + #13#10 +
    '    "name": "Project / Sequence",' + #13#10 +
    '    "levels": [' + #13#10 +
    '      { "key": "project", "label": "Project", "order": 0, "required": false },' + #13#10 +
    '      { "key": "sequence", "label": "Sequence", "order": 1, "required": false }' + #13#10 +
    '    ]' + #13#10 +
    '  },' + #13#10 +
    '  "assetBuckets": [' + #13#10 +
    '    { "id": "generated", "label": "Generated", "order": 0 },' + #13#10 +
    '    { "id": "reference", "label": "Reference", "order": 1 },' + #13#10 +
    '    { "id": "character", "label": "Character", "order": 2 },' + #13#10 +
    '    { "id": "environment", "label": "Environment", "order": 3 },' + #13#10 +
    '    { "id": "prop", "label": "Prop", "order": 4 },' + #13#10 +
    '    { "id": "turntable", "label": "Turntable", "order": 5 },' + #13#10 +
    '    { "id": "concept", "label": "Concept", "order": 6 },' + #13#10 +
    '    { "id": "final", "label": "Final", "order": 7 }' + #13#10 +
    '  ],' + #13#10 +
    '  "conflictPolicy": "uniquify",' + #13#10 +
    '  "maxConcurrentFileOps": 2,' + #13#10 +
    '  "allowedExtensionId": "{#ExtensionId}"' + #13#10 +
    '}';
  SaveStringToFile(ConfigPath, Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExePath, DefaultRoot: String;
  ResultCode: Integer;
  Launched: Boolean;
begin
  if CurStep = ssInstall then
  begin
    // Force-close any Agent process still holding the old .exe open, so the
    // file copy below doesn't silently fail — confirmed live that relying on
    // "the user already closed Chrome" wasn't reliable enough: Chrome keeps
    // this process alive as long as any extension page has an open Native
    // Messaging connection, and a locked file otherwise fails to update with
    // zero visible error in /VERYSILENT mode. Not running Chrome/the Agent
    // at all is the normal case, so a nonzero ResultCode (nothing to kill)
    // is expected and fine — only Launched (did taskkill.exe even start) is
    // worth logging.
    Launched := Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM DownloadOrganizerAgent.exe',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('taskkill launched=' + IntToStr(Ord(Launched)) + ' resultCode=' + IntToStr(ResultCode));
    // Small grace period for Windows to actually release the file handle
    // after the process exits — the kill above is synchronous, but handle
    // release isn't always instantaneous with it.
    Sleep(500);
  end;
  if CurStep = ssPostInstall then
  begin
    ForceDirectories(ConfigDir());
    ExePath := ExpandConstant('{app}\DownloadOrganizerAgent.exe');
    DefaultRoot := DefaultRootPage.Values[0];
    if DefaultRoot <> '' then
      ForceDirectories(DefaultRoot);
    WriteNativeMessagingManifest(ExePath);
    SeedConfigIfMissing(DefaultRoot);
  end;
end;
