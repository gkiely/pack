$ErrorActionPreference = "Stop"

$BaseUrl = if ($env:PACK_INSTALL_BASE_URL) { $env:PACK_INSTALL_BASE_URL } else { "https://pack.sh" }
$InstallDir = if ($env:PACK_INSTALL_DIR) { $env:PACK_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "pack\bin" }
$DeployHost = if ($env:PACK_DEPLOY_HOST) { $env:PACK_DEPLOY_HOST } elseif ($env:PACK_HOST) { $env:PACK_HOST } else { "" }
$ReleaseDomain = if ($env:PACK_RELEASE_DOMAIN) { $env:PACK_RELEASE_DOMAIN } elseif ($env:PACK_DOMAIN) { $env:PACK_DOMAIN } else { "" }
$Arch = (Get-CimInstance Win32_Processor).Architecture

function Publish-Env {
  if (-not ("Win32.NativeMethods" -as [Type])) {
    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
  IntPtr hWnd,
  uint Msg,
  UIntPtr wParam,
  string lParam,
  uint fuFlags,
  uint uTimeout,
  out UIntPtr lpdwResult);
"@
  }

  $HWND_BROADCAST = [IntPtr]0xffff
  $WM_SETTINGCHANGE = 0x1a
  $Result = [UIntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout(
    $HWND_BROADCAST,
    $WM_SETTINGCHANGE,
    [UIntPtr]::Zero,
    "Environment",
    2,
    5000,
    [ref]$Result
  ) | Out-Null
}

switch ($Arch) {
  9 { $Cpu = "x64" }
  default { throw "unsupported architecture: $Arch" }
}

if (-not $DeployHost) {
  $DeployHost = Read-Host "Deploy host, like pack@example.com"
}
if (-not $DeployHost) {
  throw "deploy host is required"
}
if ($DeployHost -notmatch '^[a-zA-Z0-9@._:-]+$' -or $DeployHost -match '^@|@$|::') {
  throw "invalid deploy host"
}

if (-not $ReleaseDomain) {
  $ReleaseDomain = Read-Host "Release domain, like example.com"
}
if (-not $ReleaseDomain) {
  throw "release domain is required"
}
if ($ReleaseDomain -notmatch '^[a-zA-Z0-9.-]+$' -or $ReleaseDomain.StartsWith(".") -or $ReleaseDomain.EndsWith(".") -or $ReleaseDomain.Contains("..")) {
  throw "invalid release domain"
}

$Url = "$BaseUrl/bin/pack-windows-$Cpu.exe"
$Target = Join-Path $InstallDir "pack.exe"
$Temp = New-TemporaryFile

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri $Url -OutFile $Temp.FullName
Move-Item -Force $Temp.FullName $Target

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$PathParts = if ($UserPath) { $UserPath -split ";" } else { @() }
if ($PathParts -notcontains $InstallDir) {
  $NewPath = (@($PathParts) + $InstallDir | Where-Object { $_ }) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
  Publish-Env
  $env:Path = (@($env:Path -split ";") + $InstallDir | Where-Object { $_ }) -join ";"
  Write-Host "added $InstallDir to user PATH"
  Write-Host "restart your terminal/editor to use pack from any directory"
}

[Environment]::SetEnvironmentVariable("PACK_DEPLOY_HOST", $DeployHost, "User")
[Environment]::SetEnvironmentVariable("PACK_RELEASE_DOMAIN", $ReleaseDomain, "User")
$env:PACK_DEPLOY_HOST = $DeployHost
$env:PACK_RELEASE_DOMAIN = $ReleaseDomain
Publish-Env

Write-Host "installed pack to $Target"
Write-Host "configured PACK_DEPLOY_HOST and PACK_RELEASE_DOMAIN"
