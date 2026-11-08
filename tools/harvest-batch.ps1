# 串行批量采集：跑完一个省再跑下一个，绝不并发（browser-profile 单实例锁）
$ErrorActionPreference = 'Continue'
$root = 'D:\Projects\上岸APP\kaogong-shuati'
Set-Location $root

$provinces = @('安徽', '山东', '广东', '云南', '浙江', '江西', '福建', '贵州')
$log = Join-Path $root 'harvest-batch.log'

foreach ($p in $provinces) {
  $ts = Get-Date -Format 'HH:mm:ss'
  "[$ts] === 开始 $p ===" | Tee-Object -FilePath $log -Append
  node tools/fenbi-fetch-solutions.mjs --course syzc --cat $p --limit 15 --gap 45 --answer 16 --pages 3 2>&1 |
    Select-String -NotMatch 'ExperimentalWarning|trace-warnings' |
    Tee-Object -FilePath $log -Append
  $ts = Get-Date -Format 'HH:mm:ss'
  "[$ts] === 结束 $p (exit=$LASTEXITCODE) ===" | Tee-Object -FilePath $log -Append
  Start-Sleep -Seconds 20
}
"全部完成" | Tee-Object -FilePath $log -Append
