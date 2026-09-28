$j = Get-Content -LiteralPath "D:\德州决策\reports\gtopen-validation\9max-cold-solve-v1\hero-allin-explain.json" -Raw | ConvertFrom-Json
$j.meta | ConvertTo-Json -Depth 12
Write-Output "===== preflopRaise ====="
if ($null -eq $j.preflopRaise) { "NULL" } else { $j.preflopRaise | ConvertTo-Json -Depth 14 }
Write-Output "===== math ====="
$j.math | ConvertTo-Json -Depth 8
