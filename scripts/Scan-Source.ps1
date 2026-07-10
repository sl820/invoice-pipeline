<#
.SYNOPSIS
  Step 1: 扫描 SourceDir 下的电子发票 PDF，过滤出还没"原位重命名"为 {交款人}.pdf 的文件。
#>
[CmdletBinding()]
param(
    [string]$SourceDir = "E:\阿里发票\阿里257张",
    [string]$OutDir
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceDir)) {
    throw "SourceDir 不存在: $SourceDir"
}

$scriptDir = Split-Path -Parent $PSCommandPath
if (-not $OutDir) { $OutDir = Join-Path $scriptDir "..\out" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile = Join-Path $OutDir "scan-$timestamp.json"

$pdfFiles = Get-ChildItem -Path $SourceDir -File -Filter "*.pdf"
$todo = New-Object System.Collections.Generic.List[object]
$skip = New-Object System.Collections.Generic.List[object]

foreach ($pdf in $pdfFiles) {
    $baseName = $pdf.BaseName
    $underscoreIdx = $baseName.IndexOf('_')

    if ($underscoreIdx -gt 0) {
        $prefix = $baseName.Substring(0, $underscoreIdx)
        if ($prefix -match '^\d{10,}$') {
            $todo.Add([PSCustomObject]@{
                pdf       = $pdf.FullName
                basename  = $baseName
                invoice_no_guess = $prefix
            })
            continue
        }
    }
    $skip.Add([PSCustomObject]@{ pdf = $pdf.FullName; basename = $baseName })
}

$report = [PSCustomObject]@{
    timestamp   = $timestamp
    source_dir  = $SourceDir
    total_pdfs  = $pdfFiles.Count
    todo_count  = $todo.Count
    skip_count  = $skip.Count
    todo        = $todo
    skipped     = $skip
}
$report | ConvertTo-Json -Depth 5 | Set-Content -Path $outFile -Encoding UTF8

Write-Host "[scan] total=$($pdfFiles.Count) todo=$($todo.Count) skipped=$($skip.Count)"
Write-Host "[scan] -> $outFile"