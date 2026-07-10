<#
.SYNOPSIS
  Step 4: 按交款人把 PDF 归档到 <ArchiveRoot>\<payer>\<payer>.pdf。

.DESCRIPTION
  - 默认不调用（Invoke-Pipeline.ps1 跳过此步）
  - 同 payer 目标已存在且 SHA256 相同 -> 跳过
  - 不同 -> 源文件保留，进 out\failed\archive-conflict-*.log
  - 注意：archive 完成后原位文件会被搬走，建议先跑完 rename 再 archive
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [Parameter(Mandatory = $true)]
    [string]$ArchiveRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path $SourceDir)) { throw "SourceDir 不存在: $SourceDir" }
if (-not (Test-Path $ArchiveRoot)) { New-Item -ItemType Directory -Path $ArchiveRoot -Force | Out-Null }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $scriptDir "..\out"
$failedDir = Join-Path $outDir "failed"
if (-not (Test-Path $failedDir)) { New-Item -ItemType Directory -Path $failedDir -Force | Out-Null }

$pdfFiles = Get-ChildItem -Path $SourceDir -File -Filter "*.pdf"
$moved = 0; $skipped = 0; $failed = 0

foreach ($pdf in $pdfFiles) {
    $payer = $pdf.BaseName  # 假定已经 rename 过，BaseName = 交款人
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    $cleanPayer = $payer
    foreach ($ch in $invalid) { $cleanPayer = $cleanPayer.Replace($ch, '_') }
    $payerDir = Join-Path $ArchiveRoot $cleanPayer
    if (-not (Test-Path $payerDir)) { New-Item -ItemType Directory -Path $payerDir -Force | Out-Null }
    $target = Join-Path $payerDir $pdf.Name
    try {
        if (Test-Path $target) {
            $a = (Get-FileHash $pdf.FullName -Algorithm SHA256).Hash
            $b = (Get-FileHash $target -Algorithm SHA256).Hash
            if ($a -eq $b) { $skipped++; continue }
            $logFile = Join-Path $failedDir "archive-conflict-$($pdf.Name).log"
            "目标已存在且哈希不同: $target" | Set-Content -Path $logFile -Encoding UTF8
            $failed++; continue
        }
        Move-Item -LiteralPath $pdf.FullName -Destination $target
        $moved++
    } catch {
        $logFile = Join-Path $failedDir "archive-error-$($pdf.Name).log"
        $_.Exception.Message | Set-Content -Path $logFile -Encoding UTF8
        $failed++
    }
}

Write-Host "[archive] 移动=$moved 跳过=$skipped 失败=$failed"