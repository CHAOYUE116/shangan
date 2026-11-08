$ErrorActionPreference = 'Stop'
$token = $env:GH_TOKEN   # 从环境变量读取，不要写死在仓库里
$h = @{ Authorization = "Bearer $token"; 'User-Agent' = 'shangan-release'; Accept = 'application/vnd.github+json' }
$proxy = 'http://127.0.0.1:18926'
$TAG = 'tiku-0.5.1-20261108-2130'
$api = 'https://api.github.com/repos/CHAOYUE116/shangan'

$rel = $null
try {
  $rel = Invoke-RestMethod "$api/releases/tags/$TAG" -Headers $h -Proxy $proxy -TimeoutSec 30
  Write-Host "reuse release id=$($rel.id)"
} catch {
  Write-Host "create release $TAG"
  $body = @{
    tag_name = $TAG
    target_commitish = 'main'
    name = 'Tiku 0.5.1-20261108-2130'
    body = 'ZhiCe 6338 questions (+821 from 2015/2016), 898 new from 8 provinces, 4693 analyses backfilled. Delta 712 KB, full 83.6 MB, images 45.7 MB.'
    draft = $false
    prerelease = $false
  } | ConvertTo-Json
  $rel = Invoke-RestMethod "$api/releases" -Method Post -Headers $h -Body $body -Proxy $proxy -TimeoutSec 30
  Write-Host "created id=$($rel.id)"
}

$uploadUrl = $rel.upload_url -replace '\{.*\}$', ''
$files = @(
  'D:\Projects\pobox\dist\release\tiku_app.db.gz'
)
$files = @(
  'D:\Projects\涓婂哺APP\dist\release\tiku_app.db.gz',
  'D:\Projects\涓婂哺APP\dist\release\images.db.gz',
  'D:\Projects\涓婂哺APP\dist\release\delta-0.4.4-20261108-1915-0.5.0-20261108-1955.json.gz',
  'D:\Projects\涓婂哺APP\dist\release\manifest.json',
  'D:\Projects\涓婂哺APP\dist\shangan-0.1.33-release.apk'
)

foreach ($f in $files) {
  if (-not (Test-Path -LiteralPath $f)) { Write-Host "skip $f"; continue }
  $name = Split-Path -Leaf $f
  $mb = [math]::Round((Get-Item -LiteralPath $f).Length / 1MB, 1)
  Write-Host ("upload {0} ({1} MB) ..." -f $name, $mb) -NoNewline
  $resp = & curl.exe -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/octet-stream" -H "User-Agent: shangan-release" --data-binary "@$f" -x $proxy "$uploadUrl`?name=$name"
  $joined = ($resp -join '')
  if ($joined -match '"size"') { Write-Host " OK" } else { Write-Host (" FAIL " + $joined.Substring(0, [Math]::Min(240, $joined.Length))) }
}

Write-Host "--- final assets ---"
$fin = Invoke-RestMethod "$api/releases/tags/$TAG" -Headers $h -Proxy $proxy -TimeoutSec 30
Write-Host $fin.html_url
foreach ($a in $fin.assets) { Write-Host ("  {0,-52} {1,8:N2} MB" -f $a.name, ($a.size / 1MB)) }
