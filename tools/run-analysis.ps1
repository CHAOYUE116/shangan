# 解析补采定时任务入口：回填 → 质检 → 达标才发版
$ErrorActionPreference = 'Continue'
$root = 'D:\Projects\上岸APP\kaogong-shuati'
Set-Location $root
$log = Join-Path 'D:\Projects\上岸APP\research' 'analysis-cron.log'
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 开始" | Out-File -FilePath $log -Append -Encoding utf8
node tools/analysis-cycle.mjs *>> $log
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 结束 exit=$LASTEXITCODE" | Out-File -FilePath $log -Append -Encoding utf8
