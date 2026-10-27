param(
  [switch]$Go2rtc
)

$ErrorActionPreference = "Stop"

$src = Split-Path -Parent $PSScriptRoot
$configDir = if ($env:SIGNALK_NODE_CONFIG_DIR) { $env:SIGNALK_NODE_CONFIG_DIR } else { Join-Path $HOME ".signalk" }
$dest = Join-Path $configDir "node_modules\signalk-mfd-cast"

New-Item -ItemType Directory -Force -Path $dest | Out-Null

Get-ChildItem -Force $src | Where-Object { $_.Name -notin @("node_modules", ".git") } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
}

Write-Host "Plugin copiado a $dest"

if ($Go2rtc) {
  $dataDir = Join-Path $configDir "plugin-config-data\signalk-mfd-cast"
  $binDir = Join-Path $dataDir "bin"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $target = Join-Path $binDir "go2rtc.exe"
  $url = "https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_win64.zip"
  $zip = Join-Path $env:TEMP "go2rtc_win64.zip"
  $extract = Join-Path $env:TEMP "go2rtc-win64"

  Write-Host "Descargando go2rtc..."
  Invoke-WebRequest -Uri $url -OutFile $zip
  Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  Copy-Item -Path (Join-Path $extract "go2rtc.exe") -Destination $target -Force
  Write-Host "go2rtc instalado en $target"
} else {
  Write-Host ""
  Write-Host "Recuerda instalar go2rtc si no lo has hecho todavía:"
  Write-Host "  powershell -File .\scripts\install-local.ps1 -Go2rtc"
}

Write-Host ""
Write-Host "Reinicia Signal K y abre: http://<ip-del-pi>:3000/signalk-mfd-cast/"
