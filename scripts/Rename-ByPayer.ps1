<#
.SYNOPSIS
  Step 3: 按 mapping 把 PDF 改名为 {交款人}.pdf。
#>
[CmdletBinding()]
param(
    [string]$SourceDir = "E:\阿里发票\阿里257张"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceDir)) { throw "SourceDir 不存在: $SourceDir" }

$scriptDir = Split-Path -Parent $PSCommandPath
$outDir = Join-Path $scriptDir "..\out"
$failedDir = Join-Path $outDir "failed"
if (-not (Test-Path $failedDir)) { New-Item -ItemType Directory -Path $failedDir -Force | Out-Null }

# 找最新 mapping（强制 UTF-8 读）
$mappingFiles = Get-ChildItem -Path $SourceDir -File -Filter "mapping-*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
if ($mappingFiles.Count -eq 0) { throw "没有 mapping-*.json，请先跑 Ocr-Bailian.ps1" }
$mappingFile = $mappingFiles[0]
Write-Host "[rename] 使用 mapping: $($mappingFile.Name)"

$rawText = [System.IO.File]::ReadAllText($mappingFile.FullName, [System.Text.UTF8Encoding]::new($false))
$records = $rawText | ConvertFrom-Json

function Sanitize-Name([string]$raw) {
    if (-not $raw) { return $null }
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    $clean = $raw
    foreach ($ch in $invalid) { $clean = $clean.Replace($ch, '_') }
    return $clean.Trim()
}

function Get-TargetPath($sourceDir, $payer, $existingSource) {
    $sanitized = Sanitize-Name $payer
    if (-not $sanitized) { return $null }
    $baseCandidate = Join-Path $sourceDir ($sanitized + ".pdf")
    if (-not (Test-Path $baseCandidate)) { return $baseCandidate }
    $existingHash = (Get-FileHash $baseCandidate -Algorithm SHA256).Hash
    $sourceHash   = (Get-FileHash $existingSource -Algorithm SHA256).Hash
    if ($existingHash -eq $sourceHash) { return $baseCandidate }
    $n = 2
    while ($true) {
        $cand = Join-Path $sourceDir ("$sanitized($n).pdf")
        if (-not (Test-Path $cand)) { return $cand }
        $h = (Get-FileHash $cand -Algorithm SHA256).Hash
        if ($h -eq $sourceHash) { return $cand }
        $n++
        if ($n -gt 99) { return $null }
    }
}

$renamed = 0
$skipped = 0
$failed = 0

foreach ($rec in $records) {
    if (-not $rec.payer) { $skipped++; continue }
    if (-not (Test-Path $rec.pdf)) {
        $logFile = Join-Path $failedDir "rename-missing-$(Split-Path -Leaf $rec.pdf).log"
        "源文件不存在: $($rec.pdf)" | Set-Content -Path $logFile -Encoding UTF8
        $failed++; continue
    }
    try {
        $target = Get-TargetPath $SourceDir $rec.payer $rec.pdf
        if (-not $target) {
            throw "后缀超过 (99) 仍未解决冲突"
        }
        $targetName = Split-Path -Leaf $target
        if ($target -eq $rec.pdf) {
            $skipped++
            continue
        }
        Rename-Item -LiteralPath $rec.pdf -NewName $targetName
        Write-Host "[rename] $($rec.pdf | Split-Path -Leaf) -> $targetName"
        $renamed++
    } catch {
        $logFile = Join-Path $failedDir "rename-conflict-$(Split-Path -Leaf $rec.pdf).log"
        "$($_.Exception.Message)" | Set-Content -Path $logFile -Encoding UTF8
        $failed++
    }
}

Write-Host "[rename] 重命名=$renamed 跳过=$skipped 失败=$failed"
$reportFile = Join-Path $outDir "report-$(Get-Date -Format 'yyyyMMdd-HHmmss')-rename.txt"
"renamed=$renamed skipped=$skipped failed=$failed`nsource=$SourceDir`nmapping=$($mappingFile.Name)" |
    Set-Content -Path $reportFile -Encoding UTF8
Write-Host "[rename] -> $reportFile"