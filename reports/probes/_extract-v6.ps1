param([string])
 = Get-Content -LiteralPath  -Raw | ConvertFrom-Json
.rows | Select-Object sizeBB,currentPot,heroStreetCommitted,villainStreetCommitted,heroAdd,villainAddRaw,villainAdd,heroContestedAdd,finalPot,uncalledReturn,f,c,rr,sum,conditionalRR,price,eqCall,eqRR,reachableCombos,callCombos,reRaiseCombos,reraiseAvailable,reRaiseTo,heroAdditionalCallVsReRaise,reraiseFoldBranchEV,reraiseCallBranchEV,reraiseBranchEV,raiseEV,recomputed,delta | Format-List
