# FAST INPUT DECISION UI V2 production baseline

Recorded original HEAD: `7dffffc965116c0a688d3357244624153def6a52`.

The original working tree contained user-owned decision changes. Those changes were included, preserved, and hashed. This is a working-tree baseline, not a pristine HEAD baseline.

## Authoritative evidence

- `baseline-before-metadata.json`: original SHA256 of domain, decisions, manual input, viewmodels, alpha pipeline, table code, artifacts, and UI; complete git status and machine/Node metadata. Captured at 04:25:55 UTC.
- `baseline-before-web-source/`: complete original UI source copy.
- `baseline-before-verify.log`: full unmodified `npm run verify` output. Exit 0, TypeScript passed, all 187 manifest artifacts matched, 2,254 tests passed across 137 suites; 0 failed/cancelled/skipped. Test duration 96,685.615 ms.
- `baseline-before-verify-summary.json`: process exit, elapsed time and log SHA256. Its counts object is empty because the initial parser expected TAP and Node emitted the spec reporter.
- `baseline-before-verify-counts.json`: actual spec-reporter totals extracted from that same unchanged log.
- `baseline-before-frozen-fixtures.json`: authoritative original production input/output snapshots, repeat runs, previews, actions, and 32BB rejection/34BB acceptance.
- `baseline-before-frozen-stable.json`: authoritative original comparison data; named timing fields and identifiers excluded, all seven repeated decision results identical.
- `baseline-before-frozen-provenance.json`: frozen source reconstruction provenance.
- `baseline-before-frozen-production/`: source used by the authoritative fixture run.

## Concurrent-edit correction

The first fixture capture (`baseline-before-fixtures.json`) overlapped authorized table readiness edits. No domain, decision, manual-input, viewmodel, or alpha-pipeline code changed, but table preview gained new readiness fields. It is retained as raw evidence, not used as the original comparison baseline. Its preliminary determinism flags also included `timingMs` and formatted `debug.timing` fields; `baseline-before-stable.json` corrects that named-field exclusion without altering the raw capture.

The authoritative run copied current source into the evidence folder and reconstructed only the two clean-at-start table files from recorded HEAD: `table.types.ts` and `tablePreview.ts`. Each reconstructed file was required to match the original SHA256 exactly, including working-tree CRLF. All other recorded non-web source hashes were verified unchanged. Production files were never rolled back or modified. `baseline-before-frozen-metadata.json` records the current workspace at reconstruction time; the original hash authority remains `baseline-before-metadata.json`.

## Reproduction and limits

Run after implementation:

```powershell
node --experimental-strip-types scripts/fast-ui-baseline.mjs --phase after
node --experimental-strip-types scripts/fast-ui-baseline.mjs --phase after --verify
```

The script refuses to overwrite raw fixture/verify evidence. It compares stable complete pipeline results separately from previews because authorized readiness additions change preview fields. Fixed `asOf=1757000000000`, `equitySeed=20260924`, and large compute budgets remove wall-clock cutoff noise. Decision logging is disabled; table history is isolated in this evidence directory. No GTO provider/network prefetch is injected, so this proves the production synchronous heuristic pipeline and frontend input equivalence, not network/solver cache behavior.

Covered ready nodes: 6-max open; 9-max open; facing 2.5BB open; facing CO 4-bet after CO 2.5BB → BTN 10BB → CO 22BB; flop, turn and river facing bets. All start from real table operations and run `handleTableRequest → tableStateToManualHandInput → parseManualInput → analyzeManualHand`.

The five-bet node has minimum raise-to 34BB. The production table API rejects 32BB and accepts 34BB. No existing engine defect was observed in these seven fixtures.
