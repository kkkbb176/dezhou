$j = Get-Content -LiteralPath "D:\德州决策\reports\gtopen-validation\9max-cold-solve-v1\cache\strategy\c7348fc89.json" -Raw | ConvertFrom-Json
$j.solveMeta | ConvertTo-Json -Depth 16
Write-Output "===== quality ====="
$j.qualitySummaryZh
$j.qualityReasonsZh | ConvertTo-Json -Depth 6
$j.qualityBlockersZh | ConvertTo-Json -Depth 6
$j.approximationFlags | ConvertTo-Json -Depth 6
$j.source | ConvertTo-Json -Depth 6
Write-Output "===== solve ====="
$j.solve | ConvertTo-Json -Depth 8
