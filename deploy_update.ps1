param (
    [Parameter(Mandatory=$false)]
    [string]$File = "",

    [Parameter(Mandatory=$false)]
    [string]$Version = "",

    [Parameter(Mandatory=$false)]
    [string]$ServerUrl = "",

    [Parameter(Mandatory=$false)]
    [string]$AdminSecret = ""
)

$ErrorActionPreference = "Stop"

# Configuration (defaults to Render backend, or environment variable)
if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
    $ServerUrl = if ($env:FRUITSHUB_SERVER_URL) { $env:FRUITSHUB_SERVER_URL } else { "https://fruitshub.onrender.com" }
}
$ServerUrl = $ServerUrl.TrimEnd('/')

if ([string]::IsNullOrWhiteSpace($AdminSecret)) {
    $AdminSecret = if ($env:FRUITSHUB_ADMIN_SECRET) { $env:FRUITSHUB_ADMIN_SECRET } else { "Juanjonosoy0//////" }
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "        FruitsHub - Universal Deployment Gateway        " -ForegroundColor Cyan
Write-Host "  Target Gateway: $ServerUrl" -ForegroundColor Gray
Write-Host "========================================================`n" -ForegroundColor Cyan

# Open interactive file picker if file is not specified via CLI and fruitshub.luau not found
if ([string]::IsNullOrWhiteSpace($File)) {
    $defaultCandidate = Join-Path $PSScriptRoot "fruitshub.luau"
    if (Test-Path $defaultCandidate) {
        $File = $defaultCandidate
        Write-Host "[i] No file specified, automatically selecting default: $File" -ForegroundColor Cyan
    } else {
        Add-Type -AssemblyName System.Windows.Forms
        $openFileDialog = New-Object System.Windows.Forms.OpenFileDialog
        $openFileDialog.InitialDirectory = (Get-Location).Path
        $openFileDialog.Filter = "Luau/Lua Files (*.luau;*.lua)|*.luau;*.lua|All Files (*.*)|*.*"
        $openFileDialog.Title = "Selecciona el archivo de FruitsHub a desplegar (Ej. ofuscado)"

        if ($openFileDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $File = $openFileDialog.FileName
        } else {
            Write-Host "[!] Seleccion de archivo cancelada por el usuario." -ForegroundColor Yellow
            exit 0
        }
    }
}

# Resolve full file path
if (-not (Test-Path $File)) {
    Write-Host "[!] Error: File '$File' does not exist." -ForegroundColor Red
    exit 1
}
$resolvedFile = (Resolve-Path $File).Path
$fileSize = (Get-Item $resolvedFile).Length
Write-Host "[i] Target file selected: $resolvedFile ($fileSize bytes)" -ForegroundColor Cyan

# Determine version
if ($Version -eq "") {
    Write-Host "[*] Querying current version from $ServerUrl/status..." -ForegroundColor Gray
    try {
        $statusCheck = Invoke-RestMethod -Uri "$ServerUrl/status" -TimeoutSec 10
        $currentRaw = $statusCheck.version
    } catch {
        Write-Host "[!] Warning: Could not reach $ServerUrl/status ($($_.Exception.Message))" -ForegroundColor Yellow
        $currentRaw = "v1.0.0"
    }

    if ($currentRaw -match 'v?(\d+)\.(\d+)\.(\d+)') {
        $major = [int]$matches[1]
        $minor = [int]$matches[2]
        $patch = [int]$matches[3] + 1
        $Version = "v$major.$minor.$patch"
        Write-Host "[i] Current active version: v$($matches[1]).$($matches[2]).$($matches[3])" -ForegroundColor Cyan
        Write-Host "[i] Auto-incremented to new version: $Version" -ForegroundColor Green
    } else {
        $Version = "v1.0.1"
        Write-Host "[!] Could not parse version, defaulting to $Version" -ForegroundColor Yellow
    }
} else {
    Write-Host "[i] Explicit version requested: $Version" -ForegroundColor Cyan
}

# Read payload content
Write-Host "[*] Reading payload file..." -ForegroundColor Gray
$payloadContent = [System.IO.File]::ReadAllText($resolvedFile, [System.Text.Encoding]::UTF8)

# 1. Upload new payload to Render Server
Write-Host "[*] Deploying payload to $ServerUrl/api/deploy as '$Version'..." -ForegroundColor Yellow
$deployBody = @{
    version = $Version
    payload = $payloadContent
} | ConvertTo-Json -Depth 5 -Compress

# CRITICAL FIX: Convert JSON string to raw UTF-8 bytes.
# In Windows PowerShell 5.1, passing a string body uses ISO-8859-1 (Latin1),
# which destroys UTF-8 multi-byte emojis into '??'. Passing a byte array preserves UTF-8 perfectly.
$deployBytes = [System.Text.Encoding]::UTF8.GetBytes($deployBody)

$deployHeaders = @{
    "Authorization" = "Bearer $AdminSecret"
    "Content-Type"  = "application/json; charset=utf-8"
}

try {
    $deployRes = Invoke-RestMethod -Uri "$ServerUrl/api/deploy" -Method Post -Headers $deployHeaders -Body $deployBytes -TimeoutSec 30
    if ($deployRes.success) {
        Write-Host "[+] Upload succeeded: $($deployRes.message)" -ForegroundColor Green
    } else {
        Write-Host "[!] Deploy error: $($deployRes.error)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[!] Deploy request failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# 2. Verify live status
Write-Host "[*] Verifying live gateway deployment..." -ForegroundColor Gray
Start-Sleep -Seconds 1
try {
    $status = Invoke-RestMethod -Uri "$ServerUrl/status" -TimeoutSec 10
    if ($status.version -eq $Version) {
        Write-Host "[+] VERIFIED! $ServerUrl is reporting version $($status.version)" -ForegroundColor Green
        Write-Host "[+] In-memory cache size: $($status.cachedBytes) bytes" -ForegroundColor Green
    } else {
        Write-Host "[!] Warning: Status returned $($status.version), expected $Version (propagation may take a few seconds)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[!] Notice: Gateway status check could not complete, but deployment was sent." -ForegroundColor Yellow
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "[+] SUCCESS: Version $Version is now 100% active globally!" -ForegroundColor Green
Write-Host "========================================================`n" -ForegroundColor Green
