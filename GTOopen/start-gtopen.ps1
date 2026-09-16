# 启动本机 GTOpen 求解器（供 Alpha 的 GtoProvider 使用）
#
# ## 用法
#
# ```powershell
# cd D:\德州\GTOopen
# .\start-gtopen.ps1            # 前台启动，Ctrl+C 停止
# .\start-gtopen.ps1 -Port 3737 # 指定端口
# ```
#
# ## 为什么不用上游的 `GTOpen.cmd`
#
# `GTOpen.cmd` 会**打开浏览器**并做一套自己的构建/复用逻辑，
# 对「让 Alpha 通过 HTTP 调用它」这件事来说是多余的副作用。
# 本脚本只做一件事：把已经编译好的 `gto-server.exe` 在正确的
# 工作目录下启起来。构建仍然用上游的方式（见 `build-gtopen.ps1`）。
#
# ## 环境变量的含义（都是**限制**，不是加速）
#
# | 变量 | 值 | 为什么 |
# |---|---|---|
# | `PREFLOP_MAX_ARENA_MB` | 1600 | 本机 16GB 内存、空闲约 4.8GB。上游默认取「空闲内存的 40%」，会随其他程序波动 —— 固定住它，让「能不能建树」变成可复现的事实 |
# | `PREFLOP_MAX_NODES` | 1200000 | 与上面的内存上限成比例（上游实测约 830 节点/arena-MB） |
# | `RAYON_NUM_THREADS` | 逻辑核心数 | 8 核 |
# | `SOLVER_GPU` | 0 | 本机没有 CUDA；显式关掉，避免求解器尝试探测 GPU |

param(
    [int]$Port = 3737,
    [int]$MaxArenaMb = 1600,
    [int]$MaxNodes = 1200000
)

$ErrorActionPreference = 'Stop'
$repo = Join-Path $PSScriptRoot 'GTOpen'
$exe = 'D:\gtopen-build\target\x86_64-pc-windows-gnu\release\gto-server.exe'

if (-not (Test-Path $exe)) {
    throw "找不到已编译的 gto-server.exe（$exe）。请先运行 .\build-gtopen.ps1"
}
if (-not (Test-Path (Join-Path $repo 'Cargo.toml'))) {
    throw "找不到 GTOpen 源码目录（$repo）"
}

$env:PORT = "$Port"
$env:PREFLOP_MAX_ARENA_MB = "$MaxArenaMb"
$env:PREFLOP_MAX_NODES = "$MaxNodes"
$env:RAYON_NUM_THREADS = "$([Environment]::ProcessorCount)"
$env:SOLVER_GPU = '0'

Write-Host "GTOpen 求解器启动中…" -ForegroundColor Cyan
Write-Host "  工作目录 : $repo"
Write-Host "  二进制   : $exe"
Write-Host "  端口     : $Port"
Write-Host "  Arena 上限: $MaxArenaMb MB / 节点上限: $MaxNodes"
Write-Host "  线程     : $env:RAYON_NUM_THREADS / GPU: 关闭"
Write-Host ""

Set-Location -LiteralPath $repo
& $exe
