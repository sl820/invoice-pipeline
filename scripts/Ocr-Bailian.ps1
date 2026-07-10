<#
.SYNOPSIS
  Step 2: OCR。优先复用 SourceDir/mapping-*.json；否则调 bl 多模态识别每个待处理 PDF 的"交款人"。
#>
[CmdletBinding()]
param(
    [string]$SourceDir = "E:\阿里发票\阿里257张",
    [switch]$ForceReOcr,
    [string]$Model = "qwen-vl-max"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceDir)) { throw "SourceDir 不存在: $SourceDir" }

$scriptDir = Split-Path -Parent $PSCommandPath
$outDir = Join-Path $scriptDir "..\out"
$failedDir = Join-Path $outDir "failed"
if (-not (Test-Path $failedDir)) { New-Item -ItemType Directory -Path $failedDir -Force | Out-Null }

# 1. 复用现有 mapping（强制 UTF-8 读，避免 PowerShell 默认按 GBK 解码出乱码）
if (-not $ForceReOcr) {
    $existingMappings = Get-ChildItem -Path $SourceDir -File -Filter "mapping-*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if ($existingMappings.Count -gt 0) {
        $latest = $existingMappings[0]
        Write-Host "[ocr] 复用 mapping: $($latest.FullName)"
        try {
            # 用 .NET 强制 UTF-8 读
            $rawText = [System.IO.File]::ReadAllText($latest.FullName, [System.Text.UTF8Encoding]::new($false))
            $records = $rawText | ConvertFrom-Json
            $count = if ($records -is [array]) { $records.Count } else { 1 }
            Write-Host "[ocr] 含 $count 条记录，跳过 bl 调用"
            return
        } catch {
            Write-Warning "[ocr] mapping 解析失败: $($_.Exception.Message)"
            Write-Warning "[ocr] 落回 bl 识别流程"
        }
    }
}

# 2. 调 bl
$blCheck = (& bl --version 2>&1) | Out-String
if ($LASTEXITCODE -ne 0) { throw "bl CLI 不可用，请先 `npm i -g bailian-cli`" }

# 提示词
$promptFile = Join-Path $scriptDir "..\prompts\extract-payer.md"
if (-not (Test-Path $promptFile)) { throw "缺少提示词: $promptFile" }
$prompt = [System.IO.File]::ReadAllText($promptFile, [System.Text.UTF8Encoding]::new($false))

$pdfFiles = Get-ChildItem -Path $SourceDir -File -Filter "*.pdf" |
    Where-Object { $_.BaseName.IndexOf('_') -ge 0 -and $_.BaseName.Substring(0, $_.BaseName.IndexOf('_')) -match '^\d{10,}$' }

if ($pdfFiles.Count -eq 0) {
    Write-Host "[ocr] 没有待处理 PDF"
    return
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$mappingFile = Join-Path $SourceDir "mapping-$timestamp.json"
$results = New-Object System.Collections.Generic.List[object]

foreach ($pdf in $pdfFiles) {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $record = [PSCustomObject]@{
        pdf        = $pdf.FullName
        payer      = ""
        invoice_no = ""
        invoice_date = ""
        amount     = ""
        method     = "bl-multimodal-understand"
        model      = $Model
        elapsed_ms = 0
        error      = ""
    }
    try {
        $jsonOut = & bl multimodal understand --file $pdf.FullName --prompt $prompt --model $Model --output json 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "bl 退出码 $LASTEXITCODE: $jsonOut"
        }
        $jsonLine = ($jsonOut | Where-Object { $_.Trim().StartsWith('{') }) | Select-Object -Last 1
        if (-not $jsonLine) { throw "bl 未返回 JSON: $jsonOut" }
        $parsed = $jsonLine | ConvertFrom-Json
        if ($parsed.payer) { $record.payer = $parsed.payer }
        if ($parsed.invoice_no) { $record.invoice_no = $parsed.invoice_no }
        if ($parsed.invoice_date) { $record.invoice_date = $parsed.invoice_date }
        if ($parsed.amount) { $record.amount = $parsed.amount }
        if (-not $record.payer) {
            $record.error = "bl 返回无 payer"
            $logFile = Join-Path $failedDir "ocr-fail-$($pdf.BaseName).log"
            ($record | ConvertTo-Json) | Set-Content -Path $logFile -Encoding UTF8
        }
    } catch {
        $record.error = $_.Exception.Message
        $logFile = Join-Path $failedDir "ocr-fail-$($pdf.BaseName).log"
        ($record | ConvertTo-Json) | Set-Content -Path $logFile -Encoding UTF8
    } finally {
        $stopwatch.Stop()
        $record.elapsed_ms = [int]$stopwatch.ElapsedMilliseconds
        $results.Add($record)
    }
}

$jsonOut = $results | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($mappingFile, $jsonOut, [System.Text.UTF8Encoding]::new($false))
$ok = ($results | Where-Object { $_.payer -and -not $_.error }).Count
$fail = $results.Count - $ok
Write-Host "[ocr] 处理 $($results.Count) 张，payer 成功=$ok 失败=$fail"
Write-Host "[ocr] -> $mappingFile"