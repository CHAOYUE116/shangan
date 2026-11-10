# 解析流水线定时入口：先采一批（有剩余才采）→ 回填 → 质检 → 达标才打包
#
# 教训：采集器和回填是两件事。之前采集器跑了整天，但没人跑回填，
# 库里缺解析一直停在 39,504，看上去就是「采了半天没动静」。
# 所以这里把两段串起来，采集是「有活才干」，回填每次都跑。
#
# 加锁：mjs 采集器会用同一个 Chrome profile，两个实例同时开必崩。
$ErrorActionPreference = 'Continue'
$root = 'D:\Projects\上岸APP\kaogong-shuati'
Set-Location $root
$res = 'D:\Projects\上岸APP\research'
$log = Join-Path $res 'analysis-cron.log'
$lock = Join-Path $res 'analysis-cron.lock'

function Say($msg) { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" | Out-File -FilePath $log -Append -Encoding utf8 }

if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalMinutes -lt 180) { Say '上一轮还在跑，跳过'; exit 0 }
  Say '锁文件超过 3 小时，视为僵死，继续'
}
New-Item -ItemType File -Path $lock -Force | Out-Null
try {
  Say '开始'

  # 1) 采集：worklist 里还有没下的卷才启动（每轮限 120 卷，避免长时间占住 profile）
  $wlFile = Join-Path $res 'solutions-worklist-pending.json'
  $env:HTTP_PROXY = 'http://127.0.0.1:18926'
  $env:HTTPS_PROXY = 'http://127.0.0.1:18926'
  node tools/mk-pending.mjs *>> $log
  if ((Test-Path $wlFile) -and ((Get-Item $wlFile).Length -gt 40)) {
    Say '有待采卷，启动采集'
    node tools/fenbi-solutions-api.mjs --list '../research/solutions-worklist-pending.json' --limit 120 --gap 8 --gapmax 120 --retry 60 --retrymax 4 --cooldown 600 --cooldownmax 24 *>> $log
  } else {
    Say '没有待采卷，跳过采集'
  }

  # 2) 回填 + 质检 + 达标打包
  node tools/analysis-cycle.mjs *>> $log
  Say "结束 exit=$LASTEXITCODE"
}
finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
