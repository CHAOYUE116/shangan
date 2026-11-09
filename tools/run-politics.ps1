# tools/run-politics.ps1 — 时政自动更新（计划任务入口）
# 由 Windows 计划任务每日调用，日志写到 tools\.logs\
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $PSScriptRoot '.logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory $logDir | Out-Null }
$log = Join-Path $logDir ('politics-' + (Get-Date -Format 'yyyyMMdd') + '.log')

Set-Location $root
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ===== 开始 =====" | Out-File -FilePath $log -Append -Encoding utf8
node tools/politics-daily.mjs --limit 12 *>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ===== 结束 code=$code =====" | Out-File -FilePath $log -Append -Encoding utf8
exit $code
