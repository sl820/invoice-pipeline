<#
.SYNOPSIS
  入口：依次跑 scan -> ocr -> rename -> archive，跳过 upload。
.PARAMETER SourceDir
  待处理目录
.PARAMETER ArchiveRoot
  若指定，跑 archive 步骤；否则原地保留
.PARAMETER ForceReOcr
  强制重新调 bl，忽略现有 mapping
.PARAMETER WhatIf
  只跑 scan，不动文件
#>
[CmdletBinding()]
param(
    [string]$SourceDir = "E:\阿里发票\阿里257张",
    [string]$ArchiveRoot,
    [switch]$ForceReOcr,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $scriptDir "..\out"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

Write-Host "==== invoice-pipeline 启动 ===="
Write-Host "SourceDir  = $SourceDir"
Write-Host "ArchiveRoot= $ArchiveRoot"
Write-Host "ForceReOcr = $ForceReOcr"
Write-Host "WhatIf     = $WhatIf"
Write-Host ""

# Step 1 scan
& (Join-Path $scriptDir "Scan-Source.ps1") -SourceDir $SourceDir -OutDir $outDir
if ($WhatIf) { Write-Host "[whatif] 终止于 scan"; return }

# Step 2 ocr
& (Join-Path $scriptDir "Ocr-Bailian.ps1") -SourceDir $SourceDir -OutDir $outDir
if ($ForceReOcr) { & (Join-Path $scriptDir "Ocr-Bailian.ps1") -SourceDir $SourceDir -OutDir $outDir -ForceReOcr }

# Step 3 rename
& (Join-Path $scriptDir "Rename-ByPayer.ps1") -SourceDir $SourceDir

# Step 4 archive (可选)
if ($ArchiveRoot) {
    & (Join-Path $scriptDir "Archive-ByPayer.ps1") -SourceDir $SourceDir -ArchiveRoot $ArchiveRoot
} else {
    Write-Host "[pipeline] 跳过 archive（未指定 -ArchiveRoot）"
}

Write-Host ""
Write-Host "==== 完成 ===="
Write-Host "失败日志: $outDir\failed\"