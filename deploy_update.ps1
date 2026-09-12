param (
    [Parameter(Mandatory=$false)]
    [string]$File = "",

    [Parameter(Mandatory=$false)]
    [string]$Version = "",

    [Parameter(Mandatory=$false)]
    [string]$ServerUrl = "",

    [Parameter(Mandatory=$false)]
    [string]$AdminSecret = "",

    [Parameter(Mandatory=$false)]
    [string]$ObfuscatorPath = "",

    [Parameter(Mandatory=$false)]
    [string]$Preset = "maximum",

    [Parameter(Mandatory=$false)]
    [string]$Seed = "",

    [Parameter(Mandatory=$false)]
    [switch]$SkipObfuscation
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
Write-Host "  Target Gateway : $ServerUrl" -ForegroundColor Gray
Write-Host "  Security Mode  : $(if ($SkipObfuscation) { 'RAW (Obfuscation Skipped)' } else { "OBNFUSCATOR [Preset: $Preset]" })" -ForegroundColor Gray
Write-Host "========================================================`n" -ForegroundColor Cyan

# 1. Resolver archivo fuente original (fruitshub.luau por defecto)
if ([string]::IsNullOrWhiteSpace($File)) {
    $defaultCandidate = Join-Path $PSScriptRoot "fruitshub.luau"
    if (Test-Path $defaultCandidate) {
        $File = $defaultCandidate
        Write-Host "[i] No file specified, automatically selecting source: $File" -ForegroundColor Cyan
    } else {
        Add-Type -AssemblyName System.Windows.Forms
        $openFileDialog = New-Object System.Windows.Forms.OpenFileDialog
        $openFileDialog.InitialDirectory = (Get-Location).Path
        $openFileDialog.Filter = "Luau/Lua Files (*.luau;*.lua)|*.luau;*.lua|All Files (*.*)|*.*"
        $openFileDialog.Title = "Selecciona el archivo de FruitsHub a desplegar"

        if ($openFileDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $File = $openFileDialog.FileName
        } else {
            Write-Host "[!] Seleccion de archivo cancelada por el usuario." -ForegroundColor Yellow
            exit 0
        }
    }
}

if (-not (Test-Path $File)) {
    Write-Host "[!] Error: File '$File' does not exist." -ForegroundColor Red
    exit 1
}
$resolvedFile = (Resolve-Path $File).Path
$sourceSize = (Get-Item $resolvedFile).Length
Write-Host "[i] Source payload selected: $resolvedFile ($sourceSize bytes)" -ForegroundColor Cyan

# 2. Determinar e incrementar version
if ($Version -eq "") {
    Write-Host "[*] Querying current active version from $ServerUrl/status..." -ForegroundColor Gray
    try {
        $statusCheck = Invoke-RestMethod -Uri "$ServerUrl/status" -TimeoutSec 10
        $currentRaw = $statusCheck.version
    } catch {
        Write-Host "[!] Warning: Could not reach $ServerUrl/status ($($_.Exception.Message))" -ForegroundColor Yellow
        $sourceExisting = [System.IO.File]::ReadAllText($resolvedFile, [System.Text.Encoding]::UTF8)
        if ($sourceExisting -match '--\[\[FH_VERSION:v?(\d+\.\d+\.\d+)\]\]') {
            $currentRaw = $matches[1]
        } else {
            $currentRaw = "v1.0.0"
        }
    }

    if ($currentRaw -match 'v?(\d+)\.(\d+)\.(\d+)') {
        $major = [int]$matches[1]
        $minor = [int]$matches[2]
        $patch = [int]$matches[3] + 1
        $Version = "v$major.$minor.$patch"
        Write-Host "[i] Current active version : v$($matches[1]).$($matches[2]).$($matches[3])" -ForegroundColor Cyan
        Write-Host "[+] Auto-incremented to    : $Version" -ForegroundColor Green
    } else {
        $Version = "v1.0.1"
        Write-Host "[!] Could not parse version, defaulting to $Version" -ForegroundColor Yellow
    }
} else {
    Write-Host "[i] Explicit version requested: $Version" -ForegroundColor Cyan
}

# 3. Actualizar cabecera de version en el codigo fuente original (fruitshub.luau)
$sourceCode = [System.IO.File]::ReadAllText($resolvedFile, [System.Text.Encoding]::UTF8)
if ($sourceCode -match '--\[\[FH_VERSION:[^\]]+\]\]') {
    $sourceCode = $sourceCode -replace '--\[\[FH_VERSION:[^\]]+\]\]', "--[[FH_VERSION:$Version]]"
} else {
    $sourceCode = "--[[FH_VERSION:$Version]]`r`n" + $sourceCode
}
[System.IO.File]::WriteAllText($resolvedFile, $sourceCode, [System.Text.Encoding]::UTF8)
Write-Host "[+] Source code stamped with version: $Version" -ForegroundColor Green

# 4. Pipeline de Ofuscacion Polimorfica (Obnfuscator)
$finalPayloadContent = ""

if (-not $SkipObfuscation) {
    Write-Host "`n--- [Obnfuscator polymorphic build pipeline] ---" -ForegroundColor Magenta

    # Localizar binario de obnfuscator
    $candidateBins = @(
        $ObfuscatorPath,
        $env:OBNFUSCATOR_PATH,
        "C:\Users\J\Desktop\obnfuscator\target\release\obnfuscator.exe",
        "C:\Users\J\Desktop\obnfuscator\target\debug\obnfuscator.exe",
        (Join-Path $PSScriptRoot "..\obnfuscator\target\release\obnfuscator.exe"),
        (Join-Path $PSScriptRoot "..\obnfuscator\target\debug\obnfuscator.exe")
    )

    $obfuscatorExe = $null
    foreach ($candidate in $candidateBins) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
            $obfuscatorExe = (Resolve-Path $candidate).Path
            break
        }
    }

    if (-not $obfuscatorExe) {
        $cmdCheck = Get-Command "obnfuscator.exe" -ErrorAction SilentlyContinue
        if ($cmdCheck) { $obfuscatorExe = $cmdCheck.Source }
    }

    if (-not $obfuscatorExe) {
        Write-Host "[!] Error: No se encontro el ejecutable 'obnfuscator.exe'." -ForegroundColor Red
        Write-Host "    Asegurate de compilar el proyecto en C:\Users\J\Desktop\obnfuscator con:" -ForegroundColor Yellow
        Write-Host "    cargo build --release" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "[i] Obfuscator Engine    : $obfuscatorExe" -ForegroundColor Cyan

    # Generar semilla criptografica aleatoria si no fue proporcionada (alternancia por cada uso)
    if ([string]::IsNullOrWhiteSpace($Seed)) {
        $guidBytes = [System.Guid]::NewGuid().ToByteArray()
        $Seed = "0x" + [System.BitConverter]::ToString($guidBytes, 0, 8).Replace("-", "")
        Write-Host "[i] Dynamic Polymorphic Seed : $Seed (Randomly rotated)" -ForegroundColor Green
    } else {
        Write-Host "[i] Explicit Seed Provided   : $Seed" -ForegroundColor Cyan
    }

    Write-Host "[i] Protection Preset        : $Preset" -ForegroundColor Cyan

    $protectedOut = Join-Path $PSScriptRoot "fruitshub_protected.luau"

    Write-Host "[*] Compiling & virtualizing AST into polymorphic VM..." -ForegroundColor Yellow
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = $obfuscatorExe
    $pinfo.Arguments = "-i `"$resolvedFile`" -o `"$protectedOut`" -p $Preset -s $Seed"
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($pinfo)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $stopwatch.Stop()

    if ($proc.ExitCode -ne 0) {
        Write-Host "[!] Obfuscation failed with exit code $($proc.ExitCode)!" -ForegroundColor Red
        if ($stderr) { Write-Host $stderr -ForegroundColor Red }
        if ($stdout) { Write-Host $stdout -ForegroundColor Yellow }
        exit 1
    }

    if (-not (Test-Path $protectedOut)) {
        Write-Host "[!] Error: Protected output '$protectedOut' was not generated." -ForegroundColor Red
        exit 1
    }

    $protectedRaw = [System.IO.File]::ReadAllText($protectedOut, [System.Text.Encoding]::UTF8)
    $protectedSize = (Get-Item $protectedOut).Length
    $expansionRatio = [math]::Round($protectedSize / [math]::Max($sourceSize, 1), 2)

    Write-Host "[+] Obfuscation completed successfully in $($stopwatch.ElapsedMilliseconds)ms!" -ForegroundColor Green
    Write-Host "    Protected Size   : $protectedSize bytes ($([math]::Round($protectedSize / 1KB, 2)) KB)" -ForegroundColor Cyan
    Write-Host "    Expansion Ratio  : ${expansionRatio}x" -ForegroundColor Cyan

    # Estampar cabecera de version compatible con loader.luau al inicio del archivo protegido
    # loader.luau busca: scriptContent:match("%-%-%[%[FH_VERSION:([%w%.]+)%]%]")
    if ($protectedRaw -notmatch '--\[\[FH_VERSION:[^\]]+\]\]') {
        $finalPayloadContent = "--[[FH_VERSION:$Version]]`r`n" + $protectedRaw
        [System.IO.File]::WriteAllText($protectedOut, $finalPayloadContent, [System.Text.Encoding]::UTF8)
    } else {
        $finalPayloadContent = $protectedRaw
    }
    Write-Host "[+] Protected payload stamped with loader version header: --[[FH_VERSION:$Version]]" -ForegroundColor Green
} else {
    Write-Host "[!] Skipping obfuscation pipeline by request. Using raw source code." -ForegroundColor Yellow
    $finalPayloadContent = $sourceCode
}

# 5. Sincronizar copias locales del servidor
Write-Host "`n[*] Synchronizing repository local server copies..." -ForegroundColor Gray
$serverPayload = Join-Path $PSScriptRoot "server\payload.luau"
if (Test-Path (Split-Path $serverPayload)) {
    [System.IO.File]::WriteAllText($serverPayload, $finalPayloadContent, [System.Text.Encoding]::UTF8)
    Write-Host "[+] Synchronized: $serverPayload" -ForegroundColor Green
}

$repoLoaderPayload = Join-Path $PSScriptRoot "repo-loader\server\payload.luau"
if (Test-Path (Split-Path $repoLoaderPayload)) {
    [System.IO.File]::WriteAllText($repoLoaderPayload, $finalPayloadContent, [System.Text.Encoding]::UTF8)
    Write-Host "[+] Synchronized: $repoLoaderPayload" -ForegroundColor Green
}

# Sincronizar copia de deploy_update.ps1 en repo-loader si existe
$repoLoaderDeployScript = Join-Path $PSScriptRoot "repo-loader\deploy_update.ps1"
if (Test-Path (Split-Path $repoLoaderDeployScript)) {
    $thisScriptContent = [System.IO.File]::ReadAllText($PSCommandPath, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($repoLoaderDeployScript, $thisScriptContent, [System.Text.Encoding]::UTF8)
    Write-Host "[+] Synchronized: $repoLoaderDeployScript" -ForegroundColor Green
}

# 6. Desplegar payload al Servidor Render (/api/deploy)
Write-Host "`n[*] Deploying payload to $ServerUrl/api/deploy as '$Version'..." -ForegroundColor Yellow
$deployBody = @{
    version = $Version
    payload = $finalPayloadContent
} | ConvertTo-Json -Depth 5 -Compress

# Conversion obligatoria a bytes UTF-8 para evitar corrupcion de caracteres en Windows PowerShell 5.1
$deployBytes = [System.Text.Encoding]::UTF8.GetBytes($deployBody)

$deployHeaders = @{
    "Authorization" = "Bearer $AdminSecret"
    "Content-Type"  = "application/json; charset=utf-8"
}

try {
    $deployRes = Invoke-RestMethod -Uri "$ServerUrl/api/deploy" -Method Post -Headers $deployHeaders -Body $deployBytes -TimeoutSec 45
    if ($deployRes.success) {
        Write-Host "[+] Gateway upload succeeded: $($deployRes.message)" -ForegroundColor Green
    } else {
        Write-Host "[!] Deploy error response: $($deployRes.error)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[!] Deploy request failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# 7. Verificacion de estado activo en vivo
Write-Host "[*] Verifying live gateway deployment..." -ForegroundColor Gray
Start-Sleep -Seconds 1
try {
    $status = Invoke-RestMethod -Uri "$ServerUrl/status" -TimeoutSec 10
    if ($status.version -eq $Version) {
        Write-Host "[+] VERIFIED! $ServerUrl is reporting active version $($status.version)" -ForegroundColor Green
        Write-Host "[+] Gateway in-memory cache size: $($status.cachedBytes) bytes" -ForegroundColor Green
    } else {
        Write-Host "[!] Warning: Status returned $($status.version), expected $Version (propagation may take a few seconds)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[!] Notice: Gateway status check could not complete, but deployment was sent." -ForegroundColor Yellow
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "[+] SUCCESS: Version $Version is now 100% active globally!" -ForegroundColor Green
Write-Host "    Protected and served directly to Roblox loader." -ForegroundColor Green
Write-Host "========================================================`n" -ForegroundColor Green
