# 真模型群场景集成测试（Windows / PowerShell）
#
# 做的事：起假 OneBot（10 条群消息，第 1 条由非白名单成员 @ 机器人）→ 起 DSH（真网关）
# → 等假 OneBot 出结论 → 打印日志 → 收尾。
#
# 前置：
#   1. bash scripts/setup.sh（或手工把 src/ 同步进 profile 的 qdash-neo）
#   2. 环境变量：
#        QDN_LLM_KEY   网关密钥（只走环境变量，不进 patch）
#        DSH_RUN       可运行的 DSH 实例目录（含 node_modules/@deepseek-ai/dsh）
#   3. test/patches/group-real.patch.yml 里的 baseURL / model 已按你的网关改好
#
# 用法：
#   $env:QDN_LLM_KEY='...'; $env:DSH_RUN='C:/path/to/dsh-run'; powershell -File scripts/group-real.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path $root '_scratch'
$dshRun = $env:DSH_RUN
# flash 判定约 2s/条，10 条 + 1 轮回答 ≈ 35s；默认给 90s 余量。
# 用 pro 判定（3~4s/条）时设 FAKE_REPORT_MS=180000。
$reportMs = if ($env:FAKE_REPORT_MS) { [int]$env:FAKE_REPORT_MS } else { 90000 }
$port = 3092

Write-Output "==> root=$root dshRun=$dshRun reportMs=$reportMs"

if (-not $env:QDN_LLM_KEY) { throw '缺少 QDN_LLM_KEY（参考 test/patches/group-real.patch.yml 的 apiKeyEnv）' }
if (-not $dshRun) { throw '缺少 DSH_RUN（指向含 node_modules/@deepseek-ai/dsh 的目录）' }

$profilePlugin = Join-Path $env:USERPROFILE '.dsh/profiles/web/node_modules/qdash-neo/src/service.js'
if (-not (Test-Path $profilePlugin)) {
  throw "profile 里没有 qdash-neo（$profilePlugin）。先跑 bash scripts/setup.sh"
}

New-Item -ItemType Directory -Force $scratch | Out-Null
$fakeOut = Join-Path $scratch 'gr-fake.out.log'
$fakeErr = Join-Path $scratch 'gr-fake.err.log'
$dshOut = Join-Path $scratch 'gr-dsh.out.log'
$dshErr = Join-Path $scratch 'gr-dsh.err.log'
$db = Join-Path $scratch 'gr.db'

foreach ($p in 3999, $port) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
}

# 上一次残留的 DSH 会握着 session 写租约 → resume 直接 SessionAlreadyOwnedError。
# 这个坑踩过：断言失败看起来像"插件 bug"，其实是两个宿主抢同一个会话。
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dsh\\lib\\bin\.js|fake-onebot\.mjs' } |
  ForEach-Object {
    Write-Output "清理遗留进程 pid=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

Remove-Item "$db", "$db-wal", "$db-shm", $fakeOut, $fakeErr, $dshOut, $dshErr -Force -ErrorAction SilentlyContinue

$env:FAKE_SCENARIO = 'group'
$env:FAKE_PORT = '3999'
$env:FAKE_REPORT_MS = "$reportMs"
$env:FAKE_PUSH_GAP_MS = '2000'
# 换一个群号：~/.dsh/sessions 里旧群号的租约/记录会让 resume 撞墙，
# 集成测试不该依赖上一次跑留下的状态
$env:FAKE_GROUP_ID = '889900'
$env:QDN_HOST_MODULES = (Join-Path $dshRun 'node_modules')

$fake = Start-Process node -ArgumentList "`"$root/test/fake-onebot.mjs`"" `
  -WorkingDirectory $root -RedirectStandardOutput $fakeOut -RedirectStandardError $fakeErr `
  -NoNewWindow -PassThru

Start-Sleep -Seconds 1

$env:QDN_DEBUG = '1'
$env:QDN_DB = $db
$env:NO_PROXY = '*'
$env:no_proxy = '*'

$dsh = Start-Process node `
  -ArgumentList "`"node_modules/@deepseek-ai/dsh/lib/bin.js`"","--profile","web","--patch","`"$root/test/patches/group-real.patch.yml`"","--port","$port","--no-open" `
  -WorkingDirectory $dshRun -RedirectStandardOutput $dshOut -RedirectStandardError $dshErr `
  -NoNewWindow -PassThru

$deadline = (Get-Date).AddSeconds(($reportMs / 1000) + 90)
while (-not $fake.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
$fake.Refresh()

Write-Output "FAKE_EXIT=$($fake.ExitCode)"
Write-Output '=== FAKE ONEBOT ==='
Get-Content $fakeOut -ErrorAction SilentlyContinue
Write-Output '=== DSH STDOUT: qdash-neo ==='
Get-Content $dshOut -ErrorAction SilentlyContinue | Select-String -Pattern 'qdash-neo|token=' | Select-Object -Last 120
Write-Output '=== DSH STDERR (tail) ==='
Get-Content $dshErr -ErrorAction SilentlyContinue | Select-Object -Last 30

Stop-Process -Id $dsh.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
Write-Output 'DONE'
