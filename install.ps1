#
# TestBench 安装脚本（Windows / PowerShell 5+）
#
#   .\install.ps1               # 安装全部工具链
#   .\install.ps1 -NoJmeter     # 跳过 JMeter
#   .\install.ps1 -Check        # 只做环境自检
#
# 安装内容：Python 虚拟环境 .venv、Locust、EvalScope、Apache JMeter（便携版）。
#
[CmdletBinding()]
param(
  [switch]$NoLocust,
  [switch]$NoEvalscope,
  [switch]$NoJmeter,
  [switch]$NoVenv,
  [switch]$WithPerf,
  [switch]$Check,
  [switch]$Strict
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ProjectDir

$JmeterVersion = if ($env:JMETER_VERSION) { $env:JMETER_VERSION } else { '5.6.3' }
$VenvDir = Join-Path $ProjectDir '.venv'
$ToolsDir = Join-Path $ProjectDir 'tools'

function Write-Step($msg) { Write-Host "`n==>  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  [x]  $msg" -ForegroundColor Red }

Write-Host "`nTestBench 安装程序" -ForegroundColor White
Write-Host "    项目目录：$ProjectDir"

Write-Step '检查基础依赖'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Fail '未找到 Node.js，请先安装 Node.js 18+：https://nodejs.org'; exit 1 }
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 18) { Write-Fail "Node.js 版本过低（需要 18+），当前 $(node -v)"; exit 1 }
Write-Ok "Node.js $(node -v)"

$python = $null
foreach ($cand in @('python', 'python3', 'py')) {
  $cmd = Get-Command $cand -ErrorAction SilentlyContinue
  if ($cmd) {
    $verOk = & $cand -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { $python = $cand; break }
  }
}
if (-not $python) {
  Write-Warn2 '未找到 Python 3.10+，Locust 与 EvalScope 将跳过安装'
  Write-Warn2 '可从 https://www.python.org/downloads/windows/ 安装（勾选 Add to PATH）'
  $NoLocust = $true
  $NoEvalscope = $true
} else {
  Write-Ok "Python $(& $python -V)"
}

$java = Get-Command java -ErrorAction SilentlyContinue
if ($java) { Write-Ok 'Java 已安装' } else { Write-Warn2 '未找到 Java，JMeter 需要 JDK 8+' }

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

if ($Check) {
  Write-Step '仅执行环境自检'
  if ($Strict) { node scripts/doctor.mjs --strict } else { node scripts/doctor.mjs }
  exit $LASTEXITCODE
}

if (-not $NoLocust -or -not $NoEvalscope) {
  if (-not $NoVenv) {
    Write-Step '准备 Python 虚拟环境'
    if (Test-Path (Join-Path $VenvDir 'Scripts\python.exe')) {
      Write-Ok "复用已有虚拟环境 $VenvDir"
    } else {
      & $python -m venv $VenvDir
      Write-Ok '虚拟环境已创建'
    }
    $pip = Join-Path $VenvDir 'Scripts\pip.exe'
  } else {
    $pip = "$python -m pip"
    Write-Warn2 '未使用虚拟环境，将安装到当前 Python 环境'
  }

  if (-not $NoLocust) {
    Write-Step '安装 Locust'
    if ($NoVenv) { & $python -m pip install --upgrade locust } else { & $pip install --quiet --upgrade locust }
    if ($LASTEXITCODE -eq 0) { Write-Ok 'Locust 安装完成' } else { Write-Fail 'Locust 安装失败' }
  }

  if (-not $NoEvalscope) {
    Write-Step '安装 EvalScope'
    $spec = if ($WithPerf) { 'evalscope[perf]' } else { 'evalscope' }
    if ($NoVenv) { & $python -m pip install --upgrade $spec } else { & $pip install --quiet --upgrade $spec }
    if ($LASTEXITCODE -eq 0) { Write-Ok "EvalScope 安装完成（${spec}）" } else { Write-Fail 'EvalScope 安装失败' }
  }
}

if (-not $NoJmeter) {
  Write-Step '安装 Apache JMeter'
  if (Get-Command jmeter -ErrorAction SilentlyContinue) {
    Write-Ok '已存在 jmeter'
  } else {
    $choco = Get-Command choco -ErrorAction SilentlyContinue
    if ($choco) {
      Write-Host '    使用 Chocolatey 安装'
      choco install jmeter -y --no-progress
    }
    if (-not (Get-Command jmeter -ErrorAction SilentlyContinue)) {
      $zip = Join-Path $ToolsDir "apache-jmeter-$JmeterVersion.zip"
      $url = "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-$JmeterVersion.zip"
      Write-Host "    下载便携版：$url"
      try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $ToolsDir -Force
        Remove-Item $zip -Force
        $extracted = Join-Path $ToolsDir "apache-jmeter-$JmeterVersion"
        $link = Join-Path $ToolsDir 'jmeter'
        if (Test-Path $link) { Remove-Item $link -Recurse -Force }
        New-Item -ItemType Junction -Path $link -Target $extracted | Out-Null
        Write-Ok 'JMeter 已解压到 tools\jmeter'
      } catch {
        Write-Warn2 "下载失败（离线环境属正常）：$($_.Exception.Message)"
      }
    }
  }
}

Write-Step '初始化数据目录'
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir 'data\runs'), (Join-Path $ProjectDir 'data\datasets') | Out-Null
Write-Ok 'data\ 已就绪'

Write-Step '环境自检'
node scripts/doctor.mjs

Write-Host "`n安装流程结束`n" -ForegroundColor White
Write-Host '  启动服务：   npm start' -ForegroundColor Cyan
Write-Host '  端到端测试： npm run smoke' -ForegroundColor Cyan
Write-Host "`n  说明：未安装的工具会以「演示模式」运行（合成数据，不会伪装成真实测量）。`n"
