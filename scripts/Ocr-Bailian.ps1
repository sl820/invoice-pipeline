<#
.SYNOPSIS
  Step 2: OCR。优先复用 SourceDir/mapping-*.json（已含 amount）；否则 PDF->PNG->bl vision describe->Node 正则解析。
#>
[CmdletBinding()]
param(
    [string]$SourceDir = "E:\阿里发票\阿里257张",
    [switch]$ForceReOcr,
    [string]$Model = "qwen3-vl-plus",
    [int]$Dpi = 200
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceDir)) { throw "SourceDir 不存在: $SourceDir" }

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$outDir = Join-Path $scriptDir "..\out"
$failedDir = Join-Path $outDir "failed"
$ocrCacheDir = Join-Path $SourceDir ".ocr-cache"
$parserScript = Join-Path $repoRoot "upload\Ocr-Parse.js"
if (-not (Test-Path $failedDir)) { New-Item -ItemType Directory -Path $failedDir -Force | Out-Null }
if (-not (Test-Path $ocrCacheDir)) { New-Item -ItemType Directory -Path $ocrCacheDir -Force | Out-Null }
$pdfFilesFromCache = $false
if (-not (Test-Path $parserScript)) { throw "找不到解析器: $parserScript" }

# 0. 找 pdftoppm
$pdftoppm = (Get-Command pdftoppm -ErrorAction SilentlyContinue).Source
if (-not $pdftoppm) {
    $candidates = @(
        "C:\Users\hbusl\AppData\Local\Microsoft\WinGet\Packages\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\poppler-25.07.0\Library\bin\pdftoppm.exe"
    )
    $pdftoppm = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $pdftoppm) { throw "找不到 pdftoppm，请安装 poppler" }

# 1. 复用 mapping（只跳过正常的，重跑异常的）
if (-not $ForceReOcr) {
    $existing = Get-ChildItem -Path $SourceDir -File -Filter "mapping-*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($existing.Count -gt 0) {
        $latest = $existing[0]
        Write-Host "[ocr] 复用 mapping: $($latest.FullName)"
        try {
            $raw = [System.IO.File]::ReadAllText($latest.FullName, [System.Text.UTF8Encoding]::new($false))
            $records = $raw | ConvertFrom-Json
            $count = if ($records -is [array]) { $records.Count } else { 1 }
            $hasAmount = ($records | Select-Object -First 1).PSObject.Properties.Name -contains "amount"
            if (-not $hasAmount) {
                Write-Host "[ocr] 旧 mapping 缺 amount 字段，强制重 OCR"
            } else {
                $needsReOcr = New-Object System.Collections.Generic.List[object]
                foreach ($rec in $records) {
                    $bad = $false
                    if ($rec.error) { $bad = $true }
                    if (-not $rec.payer) { $bad = $true }
                    if (-not $rec.amount) { $bad = $true }
                    if (-not $bad) { continue }
                    $needsReOcr.Add($rec)
                }
                $skipped = $count - $needsReOcr.Count
                Write-Host "[ocr] mapping 共 $count 条，正确=$skipped 不需重跑，需要重 OCR=$($needsReOcr.Count)"
                if ($needsReOcr.Count -eq 0) { return }
                foreach ($rec in $needsReOcr) {
                    if (Test-Path $rec.pdf) {
                        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($rec.pdf)
                        $dest = Join-Path $ocrCacheDir ($baseName + ".pdf")
                        if (-not (Test-Path $dest)) {
                            Copy-Item -Path $rec.pdf -Destination $dest -Force
                        }
                    }
                }
                $pdfFiles = Get-ChildItem -Path $ocrCacheDir -File -Filter "*.pdf"
                $pdfFilesFromCache = $true
            }
        } catch {
            Write-Warning "[ocr] mapping 解析失败: $($_.Exception.Message)"
        }
    }
}
# 2. 调 bl 前置
$blCheck = (& bl --version 2>&1) | Out-String
if ($LASTEXITCODE -ne 0) { throw "bl CLI 不可用" }

# 3. 提示词
$promptFile = Join-Path $scriptDir "..\prompts\extract-payer.md"
if (-not (Test-Path $promptFile)) { throw "缺少提示词: $promptFile" }
$prompt = [System.IO.File]::ReadAllText($promptFile, [System.Text.UTF8Encoding]::new($false))

# 4. 待处理 PDF
if (-not $pdfFilesFromCache) {
    $pdfFiles = Get-ChildItem -Path $SourceDir -File -Filter "*.pdf" |
        Where-Object { $_.BaseName.IndexOf('_') -ge 0 -and $_.BaseName.Substring(0, $_.BaseName.IndexOf('_')) -match '^\d{10,}$' }
}

if ($pdfFiles.Count -eq 0) { Write-Host "[ocr] 没有待处理 PDF"; return }

# 5. 主循环
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$mappingFile = Join-Path $SourceDir "mapping-$timestamp.json"
$results = New-Object System.Collections.Generic.List[object]

foreach ($pdf in $pdfFiles) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $record = [PSCustomObject]@{
        pdf          = $pdf.FullName
        payer        = ""
        amount       = ""
        invoiceDate  = ""
        method       = "bl-vision-describe+regex"
        model        = $Model
        elapsedMs    = 0
        error        = ""
    }
    try {
        # 5a. PDF -> PNG
        $pngBase = Join-Path $ocrCacheDir ($pdf.BaseName + "-p1")
        $pngFile = "$pngBase.png"
        if (-not (Test-Path $pngFile)) {
            Write-Host "[ocr] $($pdf.Name) -> PNG"
            # PowerShell 调用外部程序对中文路径支持不好，复制到 ASCII 临时名再处理
            $tmpHash = ([System.IO.Path]::GetFileNameWithoutExtension($pdf.FullName)).GetHashCode()
            $tmpPdf = Join-Path $ocrCacheDir ("tmp_$tmpHash.pdf")
            if (-not (Test-Path $tmpPdf)) { Copy-Item -Path $pdf.FullName -Destination $tmpPdf -Force }
            $tmpBase = Join-Path $ocrCacheDir ("tmp_${tmpHash}_p1")
            & $pdftoppm -r $Dpi -png -f 1 -l 1 $tmpPdf $tmpBase 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "pdftoppm 失败" }
            $generated = "$tmpBase-1.png"
            if (Test-Path $generated) {
                Move-Item -Path $generated -Destination $pngFile -Force
                Remove-Item -Path $tmpPdf -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not (Test-Path $pngFile)) { throw "PNG 未生成" }

        # 5b. bl vision describe 转写
        $blOut = & bl vision describe --image $pngFile --prompt $prompt --model $Model --output json 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            # bl 错误时 PowerShell 会把 node stderr 也写到 stdout，取最后一段非空行作为 error
            $blErr = ($blOut -split "`n" | Where-Object { $_ -match "message|Error|error|API" } | Select-Object -Last 1)
            if (-not $blErr) { $blErr = $blOut.Trim() }
            throw "bl 调用失败 (exit $LASTEXITCODE): $blErr"
        }

        # 5c. 保存原始 OCR 文本到 .ocr-cache
        $ocrTxt = Join-Path $ocrCacheDir ($pdf.BaseName + "-ocr.txt")
        [System.IO.File]::WriteAllText($ocrTxt, $blOut, [System.Text.UTF8Encoding]::new($false))

        # 5d. 用 Node 解析器抽 payer + amount + invoiceDate（payer 优先文件名）
        $parsed = & node $parserScript $ocrTxt 2>&1 | Out-String
        try {
            $parsedObj = $parsed | ConvertFrom-Json
            # payer 优先取文件名（ground truth），OCR 抽到的存 ocrPayer 备查
            $filenameCompany = $pdf.BaseName.Substring($pdf.BaseName.IndexOf('_') + 1)
            $record.payer = $filenameCompany
            if ($parsedObj.payer) { $record.ocrPayer = [string]$parsedObj.payer }
            if ($parsedObj.amount) { $record.amount = [string]$parsedObj.amount }
            if ($parsedObj.invoiceDate) { $record.invoiceDate = [string]$parsedObj.invoiceDate }
        } catch {
            throw "解析器返回非 JSON: $parsed"
        }


        if (-not $record.payer) {
            $record.error = "解析后 payer 为空"
            $logFile = Join-Path $failedDir "ocr-fail-$($pdf.BaseName).log"
            ($record | ConvertTo-Json) | Set-Content -Path $logFile -Encoding UTF8
        }
    } catch {
        $record.error = $_.Exception.Message
        $logFile = Join-Path $failedDir "ocr-fail-$($pdf.BaseName).log"
        ($record | ConvertTo-Json) | Set-Content -Path $logFile -Encoding UTF8
    } finally {
        $sw.Stop()
        $record.elapsedMs = [int]$sw.ElapsedMilliseconds
        $results.Add($record)
    }
}

$json = $results | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($mappingFile, $json, [System.Text.UTF8Encoding]::new($false))
$ok = ($results | Where-Object { $_.payer -and -not $_.error }).Count
$fail = $results.Count - $ok
Write-Host "[ocr] 处理 $($results.Count) 张，payer 成功=$ok 失败=$fail"
Write-Host "[ocr] -> $mappingFile"