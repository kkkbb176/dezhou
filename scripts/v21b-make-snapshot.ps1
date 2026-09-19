# V2.1 第二轮 · 隔离工作副本构建（可核验快照）
#
# 目的：把「当前交付状态」（HEAD + 全部 tracked 修改 + 全部 untracked 文件）
# 复制到 D:\德州-v21-audit-snapshot，并在复制前后核对源文件哈希，
# 确保快照是一个**一致的**状态，而不是混合版本。
#
# ⚠️ 本脚本**不修改原工作区**：只读原工作区，只写副本目录。
#    不使用 git reset / clean / checkout，不使用 git worktree（那只能拿到 HEAD）。

$ErrorActionPreference = 'Stop'
$src = 'D:\德州'
$dst = 'D:\德州-v21-audit-snapshot'

Write-Output "=== 0. 源状态 ==="
Push-Location $src
$head = (git rev-parse HEAD).Trim()
$statusLines = git status --porcelain=v1
$modified = @($statusLines | Where-Object { $_ -match '^ ?M' } | ForEach-Object { $_.Substring(3).Trim('"') })
$untracked = @($statusLines | Where-Object { $_ -match '^\?\?' } | ForEach-Object { $_.Substring(3).Trim('"') })
$tracked = @(git ls-files)
Write-Output "HEAD            = $head"
Write-Output "tracked 文件数  = $($tracked.Count)"
Write-Output "tracked 修改数  = $($modified.Count)"
Write-Output "untracked 数    = $($untracked.Count)"

# ---- 复制清单 = tracked ∪ modified ∪ untracked ----
$payload = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $tracked)   { [void]$payload.Add($p) }
foreach ($p in $modified)  { [void]$payload.Add($p) }
foreach ($p in $untracked) { [void]$payload.Add($p) }

# GTOopen 是外部求解器（260MB，.gitignore 排除），不复制；但 manifest 列了它的启动脚本
$payload = @($payload | Where-Object { $_ -notlike 'GTOopen/*' -or $_ -eq 'GTOopen/start-gtopen.ps1' })
Write-Output "复制清单条目数   = $($payload.Count)"
Pop-Location

Write-Output ""
Write-Output "=== 1. 复制前源哈希（关键文件 + 全部 payload）==="
Push-Location $src
$before = @{}
$files = New-Object System.Collections.Generic.List[string]
foreach ($p in $payload) {
  $full = Join-Path $src $p
  if (Test-Path -LiteralPath $full -PathType Leaf) { $files.Add($p) }
}
foreach ($p in $files) {
  $before[$p] = (Get-FileHash -LiteralPath (Join-Path $src $p) -Algorithm SHA256).Hash
}
Write-Output "参与哈希核对的文件数 = $($files.Count)"
Pop-Location

Write-Output ""
Write-Output "=== 2. 清理并重建副本目录 ==="
if (Test-Path $dst) {
  Write-Output "副本目录已存在 ⇒ 先移除（只动副本，不动原工作区）"
  # 先断开 junction，避免递归删除穿透到原工作区的 node_modules
  foreach ($j in @('node_modules','GTOopen')) {
    $jp = Join-Path $dst $j
    if (Test-Path $jp) {
      $item = Get-Item $jp -Force
      if ($item.LinkType -eq 'Junction') { cmd /c rmdir "$jp" | Out-Null }
    }
  }
  Remove-Item -LiteralPath $dst -Recurse -Force
}
New-Item -ItemType Directory -Path $dst -Force | Out-Null

Write-Output ""
Write-Output "=== 3. 按目录批量复制 ==="
# 收集需要复制的目录（去重），逐个 robocopy（比逐文件快得多）
$dirs = @{}
foreach ($p in $payload) {
  $d = Split-Path $p -Parent
  if ([string]::IsNullOrEmpty($d)) { $d = '.' }
  $dirs[$d] = $true
}
$dirList = @($dirs.Keys | Sort-Object)
Write-Output "涉及目录数 = $($dirList.Count)"

# 用 robocopy 复制「副本所需的最小目录集合」：src/test/scripts/reports/docs/data/logs 与根级文件
$topDirs = @('src','test','scripts','reports','docs','data','logs')
foreach ($d in $topDirs) {
  $s = Join-Path $src $d
  if (-not (Test-Path $s)) { continue }
  $t = Join-Path $dst $d
  $null = robocopy $s $t /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
  Write-Output ("  {0,-10} -> exit {1}" -f $d, $LASTEXITCODE)
}
# 根级文件
$rootFiles = @($payload | Where-Object { $_ -notmatch '[\\/]' })
foreach ($f in $rootFiles) {
  Copy-Item -LiteralPath (Join-Path $src $f) -Destination (Join-Path $dst $f) -Force
}
Write-Output "根级文件已复制：$($rootFiles -join ', ')"

# GTOopen：只取 manifest 需要的那一个文件 + 用 junction 暴露其余（junction 不占空间、不改原目录）
New-Item -ItemType Directory -Path (Join-Path $dst 'GTOopen') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $src 'GTOopen/start-gtopen.ps1') -Destination (Join-Path $dst 'GTOopen/start-gtopen.ps1') -Force

# node_modules：整目录复制（25MB），避免 junction 带来的共享可写风险
Write-Output "复制 node_modules（25MB，独立副本，不用 junction）"
$null = robocopy (Join-Path $src 'node_modules') (Join-Path $dst 'node_modules') /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
Write-Output "  node_modules -> exit $LASTEXITCODE"

# .git：只复制最小内容（HEAD 指针），不复制 GTOopen 历史 → 让副本可查 HEAD 但不参与提交
New-Item -ItemType Directory -Path (Join-Path $dst '.git') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $dst '.git/HEAD') -Value "ref: refs/heads/main`n" -NoNewline
Write-Output "副本 .git 只写入 HEAD 指针（副本不用于 git 操作，仅记录来源）"

Write-Output ""
Write-Output "=== 4. 复制后回读源哈希，核对复制期间源是否变化 ==="
Push-Location $src
$changed = New-Object System.Collections.Generic.List[string]
foreach ($p in $files) {
  $h = (Get-FileHash -LiteralPath (Join-Path $src $p) -Algorithm SHA256).Hash
  if ($h -ne $before[$p]) { $changed.Add($p) }
}
Pop-Location
if ($changed.Count -eq 0) {
  Write-Output "✔ 复制期间源文件**零变化**（$($files.Count) 个文件哈希一致）⇒ 快照一致"
} else {
  Write-Output "✖ 复制期间源发生变化，快照可能不一致："
  $changed | ForEach-Object { Write-Output "    $_" }
}

Write-Output ""
Write-Output "=== 5. 副本侧核对：逐文件比对副本与源的哈希 ==="
$mismatch = New-Object System.Collections.Generic.List[string]
foreach ($p in $files) {
  $sFull = Join-Path $src $p
  $dFull = Join-Path $dst $p
  if (-not (Test-Path -LiteralPath $dFull -PathType Leaf)) { $mismatch.Add("MISSING: $p"); continue }
  $hs = (Get-FileHash -LiteralPath $sFull -Algorithm SHA256).Hash
  $hd = (Get-FileHash -LiteralPath $dFull -Algorithm SHA256).Hash
  if ($hs -ne $hd) { $mismatch.Add("DIFF: $p") }
}
if ($mismatch.Count -eq 0) {
  Write-Output "✔ 副本逐文件一致（$($files.Count) 个文件）"
} else {
  Write-Output "✖ 副本不一致："
  $mismatch | ForEach-Object { Write-Output "    $_" }
}

Write-Output ""
Write-Output "=== 6. 快照来源记录 ==="
$record = @(
  "snapshotOf      = $src"
  "snapshotAt      = $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  "HEAD            = $head"
  "trackedFiles    = $($tracked.Count)"
  "trackedModified = $($modified.Count)"
  "untracked       = $($untracked.Count)"
  "hashedFiles     = $($files.Count)"
  "sourceStable    = $($changed.Count -eq 0)"
  "copyConsistent  = $($mismatch.Count -eq 0)"
  "excluded        = GTOopen/* (260MB 外部求解器，仅保留 start-gtopen.ps1)"
  ""
  "--- tracked 修改清单 ---"
) + $modified + @("", "--- untracked 清单 ---") + $untracked
Set-Content -LiteralPath (Join-Path $dst 'SNAPSHOT_PROVENANCE.txt') -Value $record -Encoding UTF8
Write-Output "已写入 $dst\SNAPSHOT_PROVENANCE.txt"

Write-Output ""
Write-Output "=== 7. 副本大小 ==="
$sz = (Get-ChildItem $dst -Recurse -File | Measure-Object Length -Sum).Sum
Write-Output ("副本大小 = {0:N1} MB" -f ($sz/1MB))
