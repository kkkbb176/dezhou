# V2.1 REVIEW 4 — NUMERICAL CORRECTNESS AND TEST TRUSTWORTHINESS

**Reviewer**: Reviewer 4 (adversarial, independent)
**Repository**: `D:\德州` @ `c3391ef`
**Scope**: rounding discipline · threshold boundaries · odds-ratio numerics · mass conservation ·
normalisation stability · test trustworthiness · the two `MEDIUM_VALUE` enums
**Method**: read-only. **No file under `src/` or `test/` was modified.** All evidence produced by
execution via probe scripts `scripts/v21-rev4-*.ts` and `node --test --experimental-strip-types`.
Node v24.19.0.

---

## VERDICT TABLE

| # | Item | Verdict | Severity | Conflict |
|---|---|---|---|---|
| 1 | Rounding discipline (audit scripts + V2 report) | **FAIL** | **HIGH** | **YES** |
| 2 | Boundary reversal of `profileMaterialityOf` | **FAIL** | MEDIUM | **YES** |
| 3 | Odds-ratio numerics (`rateOdds` / `cond` / geometric mean / clamp) | PASS_WITH_WARNINGS | LOW | no (warnings only) |
| 4 | Mass conservation (`profileClassMasses`) | PASS_WITH_WARNINGS | LOW | no (≤1.11e-15 order-of-summation only) |
| 5 | Normalisation stability (log-space / max-shift) | PASS_WITH_WARNINGS | MEDIUM | no for the ≤1e300 claim; **silent-underflow warning** |
| 6 | Test trustworthiness (6 profile tests) | **FAIL** | **HIGH** | **YES** |
| 7 | The two same-named `MEDIUM_VALUE` enums | PASS | — | no |

Reference fixture used throughout: the golden hand 03A/03B (9-max, Hero CO `Ac Jh`, board
`Ad 8s 4s 2c Kd`, BB bet 75% on river after Hero turn check-back). 990 legal combos, **449 reachable**.

---

## 1. ROUNDING DISCIPLINE

**CLAIM**: no verdict in the audit scripts or the V2 report is computed from a rounded/formatted value.

### EVIDENCE

**1a. `scripts/v21-profile-sensitivity-audit.ts` — MATERIALITY input is unrounded, but the
verdict is computed on a *composite* that no measured row produced.**

```text
L778-779  const maxAbsEq = deltas.reduce(...)   // 独立归约
L779      const maxAbsBm = deltas.reduce(...)   // 独立归约
L794-802  profileMaterialityOf({ equityB: neutral.heroEquity + maxAbsEq.eq,
                                 bluffMassB: (neutral.bluffMass ?? 0) + maxAbsBm.bm})
```
- `toFixed` is used **only** in `fmt` (L757) and display strings (L769, L780-781, L789, L817).
  No `toFixed`/`Math.round` output reaches a comparison. ✔
- **But**: `maxAbsEq` and `maxAbsBm` are two *independent* reductions over the same array, so the
  `(equityDelta, bluffMassDelta)` pair handed to `profileMaterialityOf` is a **synthetic pair** that
  may combine the equity delta of row *i* with the bluff-mass delta of row *j*. The resulting
  verdict is not the verdict of any measured profile configuration. (In this run both maxima
  happened to come from the 03A→03B pair, but nothing in the code enforces it.)
- **Reassociation error**: the script feeds `a + (b − a)` rather than the measured `b`.
  Measured: `base + delta − base !== delta` in **43/45** equity probes and **27/30** mass probes,
  with errors up to **5.204e-18** at base 0.5 / delta 0.005 — i.e. **15 ULP at 0.005** and
  **15 ULP at 0.02**. The comparison value is therefore not bit-identical to the measurement.

**1b. `scripts/v21-decision-impact.ts:252-260` — VERDICT DERIVED FROM A REGEX OVER A FORMATTED
CHINESE STRING. This is a direct violation of "must not use rounded display values in judgements".**

```ts
L253 const ranges = built.context.postflopFacts?.opponentRangeFacts as
       | { updateTrace?: readonly { noteZh?: string }[] } | undefined;
L256 const notes = (ranges?.updateTrace ?? []).map((t) => t.noteZh ?? '').join('\n');
L257 const clampMatch = /钳位 (\d+)\/(\d+)/.exec(notes);
L258 if (clampMatch !== null) out.clampedCount = Number(clampMatch[1]);
L259 const traitMatch = /条目数 (\d+)–(\d+)/.exec(notes);
L546 if (s.clampedCount !== null && s.clampedCount > 0)
       violations.push(`似然被钳位 ${s.clampedCount} 个组合（类别区分被压平）`);
```

**Executed proof of the fail-open path** (`scripts/v21-rev4-clamp-path.ts`):

```text
opponentRangeFacts 的键 = strongShare, topPairPlusShare, meanTier, suitFit, drawShare,
                          tierHistogram, weakerShare, equalShare, strongerShare, supportSize,
                          counts, actionMasses, profileClassMasses
opponentRangeFacts.updateTrace = undefined          ← 审计脚本读的就是这个
context.range.updateTrace 长度 = 4
    RIVER/BET：noteZh 长度=116
        统一动作似然 V2（…）：RIVER/BB/SRP/TURN_CHECK_BACK/LARGE/DRY；条目数 0–3；钳位 0/990（无饱和）
【复刻 v21-decision-impact.ts:252-260】notes 长度 = 0
    clampMatch = null ⇒ clampedCount = null（检查静默失效）
    traitMatch = null ⇒ traitCountRange = null
    判定「似然被钳位」违规 = false   ← 即使真实钳位数 > 0 也恒为 false
【正确位置 context.range.updateTrace】clampMatch = ["钳位 0/990","0","990"]
```

`opponentRangeFacts` has **no** `updateTrace` field (the trace lives on `context.range.updateTrace`,
`decision.types.ts:553`). Consequently the regex never matches, `clampedCount` is always `null`, and
`clampedCount !== null && > 0` is **always false**. Confirmed in the artifact
`reports/evidence/v21-decision-impact.json`: **all 11 `profileDominance.rows[]` carry
`clampedCount: null`, `traitCountRange: null`, `violated: false`** — while the declared check list
includes `"似然钳位次数 = 0（否则类别区分被压平）"`.

**1c. Clamping IS reachable, so the dead check is not academic** (`scripts/v21-rev4-clamp-path.ts`,
observed success = opportunities on `riverBluff` / `missedDrawBluff` / `riverLargeBetBluff`, no tag,
LARGE + TURN_CHECK_BACK, betRatio 0.75, bucket 5):

| n (successes/opportunities) | combinedAdjustment | rawLikelihood | likelihood | clamped |
|---|---|---|---|---|
| 50/50 | 11.357120 | 0.62291847 | 0.6229 | false |
| 75/75 | 14.794989 | 0.81147961 | 0.8115 | false |
| 100/100 | 17.870005 | 0.98013898 | 0.9801 | false |
| **150/150** | **23.346976** | **1.2805414** | **1.000** | **true** |
| 200/200 | 28.240790 | 1.5489586 | 1.000 | true |
| 500/500 | 51.880382 | 2.8455495 | 1.000 | true |
| 1e6/1e6 | 3033.5524 | 166.38512 | 1.000 | true |
| 1e9/1e9 | 3033.5524 | 166.38512 | 1.000 | true |

⇒ saturation begins at **n ≈ 120** observed hands per trait at 100% success. At n = 1e6 the raw
likelihood is **166.4× over the ceiling** and is silently flattened to `1.0`, which is exactly the
"category separation is destroyed" condition the check was written to catch. The check cannot see it.

**1d. V2 report — threshold comparisons written in display-rounded units.**

```text
reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md
L241  rangeDistance    = TV 0.0422 / JS 0.0128
L242  materiality      = TRIVIAL（equityDelta 0.0180 < equityMaterial 0.02
L243                       ∧ bluffMassDelta 0.0422 < massMaterial 0.05）
L246  ⚠️ 严格按 MATERIALITY_THRESHOLDS：equityMaterial = 0.02，实测 0.0180
L257  按 profileMaterialityOf() 的规则，两个维度都未达各自阈值（equity 0.0180 < 0.02
L375  §二十五：画像影响已从 0.79pp 提到 1.80pp（≈2.3×），但权益维度仍差一点点
```
Independently measured raw deltas (production `buildDecisionContext`, golden hand):
```text
equityDelta      = 0.5760913804269139  − 0.5580798411791583  = 0.01801153924775563   (1.80115pp)
bluffMassDelta   = 0.05001416632562606 − 0.007845992393969235 = 0.042168173931656825 (4.21682pp)
```
The verdict `TRIVIAL` is **correct** for both the rounded and the raw values — margins are
1.9885e-3 (vs a 5e-5 display quantum) and 7.8318e-3. **No verdict is flipped by rounding.**
Latent hazard: if a future measurement lands at 0.01999xx the report would print
`0.0200 < 0.0200`, which is self-contradictory; the comparison should be stated in raw units.

**1e. The report states the wrong *reason* for TRIVIAL.** L242-243 gives a conjunction of
"below material" — that is branch **A** semantics (`|eq| < equityTrivial ∧ |mass| < massTrivial`).
The actual branch taken is the **fall-through D**, because `0.018 > equityTrivial (0.005)` and
`0.0422 > massTrivial (0.01)`. The outcome coincides; the stated rule does not.

**1f. `test/reportVerdictConsistency.test.ts:42-57` `verdictOf()` is not a faithful oracle at the
precision its own docstring claims.** It reconstructs `equityB = 0.5 + equityDelta`:

| intended delta | direct (`A=0`) | via `verdictOf` helper | agrees? |
|---|---|---|---|
| `equityMaterial − 1 ULP` = 0.019999999999999996947 | TRIVIAL | **MATERIAL** | **NO** |
| `equityStrong − 1 ULP` = 0.049999999999999995837 | MATERIAL | **STRONG** | **NO** |
| `equityMaterial` = 0.020000000000000000416 | MATERIAL | MATERIAL | yes |
| `equityStrong` = 0.050000000000000002776 | STRONG | STRONG | yes |

The helper's reconstruction noise is up to **5.204e-17 (15 ULP)** — larger than 1 ULP at every
threshold. Case D's offsets (1e-7) are ≫ that noise, so today's assertions still test what they
claim; but the file's own comment ("浮点边界不得因四舍五入而错位") overstates the resolution it
actually exercises.

**CONFLICT: YES** — (i) `v21-decision-impact.ts:257-258` + `:546` derives a violation verdict from a
regex over a formatted Chinese log string, and the read is from the wrong object so the verdict is
fail-open (`clampedCount: null` in all 11 rows of `v21-decision-impact.json`); (ii) the report
compares display-rounded 0.0180/0.0422 against thresholds; (iii) the test helper perturbs boundary
deltas by up to 15 ULP.

**RESOLUTION**: replace the regex with a structured field. The production value already exists
(`contextBuilder.ts:1297 clampedCount`) — surface it as a numeric field on
`OpponentRangeFacts`/`RangeSnapshot` (e.g. `clampedCount`, `appliedTraitCountRange`) and read it
directly. Make the probe **fail closed**: if the field is absent, record
`CLAMP_CHECK_UNAVAILABLE` rather than `violated: false`. Report threshold comparisons in raw units
and cite the raw deltas alongside the pp display.

---

## 2. BOUNDARY REVERSAL OF `profileMaterialityOf`

**CLAIM**: TRIVIAL/MATERIAL/STRONG is decided by `Math.abs(equityDelta)` / `Math.abs(bluffMassDelta)`
against 0.005 / 0.02 / 0.05 / 0.01, and is stable to 1-ULP noise on both sides.

### EVIDENCE

ULP sizes: `ulp@0.005 = 8.673617379884035e-19`, `ulp@0.02 = 3.469446951953614e-18`,
`ulp@0.05 = 6.938893903907228e-18`, `ulp@0.01 = 1.734723475976807e-18`.
All verdicts below are **direct** (`equityA = 0`, `bluffMassA = 0`, so the delta reaches the
comparison untouched):

| threshold | −1 ULP | == threshold | +1 ULP |
|---|---|---|---|
| `equityTrivial` 0.005 | TRIVIAL | TRIVIAL | TRIVIAL |
| `equityMaterial` 0.02 | **TRIVIAL** | **MATERIAL** | MATERIAL |
| `equityStrong` 0.05 | **MATERIAL** | **STRONG** | STRONG |
| `massTrivial` 0.01 | TRIVIAL | TRIVIAL | TRIVIAL |
| `massMaterial` 0.05 | **TRIVIAL** | **MATERIAL** | MATERIAL |

**2a. `equityTrivial` (0.005) and `massTrivial` (0.01) are DEAD PARAMETERS.**
Source branches: `A: |eq|<TRIV ∧ |mass|<MTRIV ⇒ TRIVIAL`; `B: |eq|≥STRONG ⇒ STRONG`;
`C: |eq|≥MAT ∨ |mass|≥MMAT ⇒ MATERIAL`; `D: else ⇒ TRIVIAL`. **A and D return the same constant.**
Executed proof (`scripts/v21-rev4-thresholds.ts`, §9): on a **34 191-point grid**, mutating
`equityTrivial → 0.0199999` and `massTrivial → 0.0499999` changes the verdict **0 times**; the local
isomorphic copy differs from production in **0/34 191** cells (copy verified faithful). Therefore the
"1 ULP of 0.005 / 0.01 on both sides" boundaries produce **no discontinuity at all** — because they
control nothing.

**2b. The real discontinuities (0.02 equity, 0.05 equity, 0.05 mass) are exactly at the threshold and
deterministic.** Both are `>=`, so a delta of exactly `MATERIALITY_THRESHOLDS.equityMaterial` (whose
double value is 0.020000000000000000416) yields MATERIAL, and one ULP below yields TRIVIAL. Subject
to that, the verdict is stable: a monotonicity sweep over `|eq| ∈ [0, 0.06]` (step 5e-4) found
**0 demotions**. A verdict can only flip if the delta lands within **1 ULP** of 0.02 or 0.05
(probability ~1e-16 for a Monte-Carlo-compared equity), so the *reported* verdict is not
practically unstable to floating-point noise. **However**, the audit path feeds a value that is
reconstructed (`a + (b − a)`) and therefore displaced by up to 5.2e-17 (**15 ULP**) — 15× the
boundary width. That, not the function itself, is where instability lives.

**2c. Display contradicts the verdict at those boundaries** (`scripts/v21-rev4-thresholds.ts`, §10):

```text
eqDelta = 0.05 − 1ULP = 0.0499999999999999958367 ⇒ verdict MATERIAL
   noteZh = 画像物性 MATERIAL（EXPERIMENTAL 阈值）：权益差 5.00pp｜…
eqDelta = 0.05        = 0.0500000000000000027756 ⇒ verdict STRONG
   noteZh = 画像物性 STRONG（EXPERIMENTAL 阈值）：权益差 5.00pp｜…
eqDelta = 0.02 − 1ULP = 0.0199999999999999969469 ⇒ verdict TRIVIAL
   noteZh = 画像物性 TRIVIAL（EXPERIMENTAL 阈值）：权益差 2.00pp｜…
massDelta = 0.05 − 1ULP                         ⇒ verdict TRIVIAL
   noteZh = …诈唬质量差 5.00pp｜…
```
A reader comparing the published "5.00pp" against the documented 0.05 threshold would conclude
STRONG while the verdict says MATERIAL (and, for mass, TRIVIAL while showing "5.00pp").

**2d. `equityDelta === null` ⇒ `NO_EFFECT` — CORRECT, but it swallows the mass dimension.**
```text
A null / B number : NO_EFFECT
A number / B null : NO_EFFECT
both null         : NO_EFFECT
A null, bluffMassDelta = 0.5 (10× massMaterial): NO_EFFECT
```
All three null placements yield `NO_EFFECT`. That is the intended semantic, but note that
`bluffMassDelta = 0.5` — ten times `massMaterial` — produces no signal whatsoever.

**2e. NaN slips through — CONFIRMED.**

```text
equityA=0, equityB=NaN            verdict=TRIVIAL   equityDelta=NaN   bluffMassDelta=0.0000000000000000000  noteZh含NaN=true
equityA=NaN, equityB=0.6          verdict=TRIVIAL   equityDelta=NaN                        noteZh含NaN=true
equityA=Infinity,equityB=Infinity verdict=TRIVIAL   equityDelta=NaN                        noteZh含NaN=true
equityB=Infinity                  verdict=STRONG    equityDelta=Infinity                   noteZh含NaN=false
bluffMassB=NaN（权益 0.001）       verdict=TRIVIAL   equityDelta=0.0010000000000000000208  bluffMassDelta=NaN
bluffMassB=NaN（权益 0.03）        verdict=MATERIAL  equityDelta=0.029999999999999998890 bluffMassDelta=NaN
equityB=+Infinity ⇒ noteZh = 画像物性 STRONG（…）：权益差 Infinitypp｜诈唬质量差 0.00pp｜…
```
Mechanism: `equityDelta === null` is false for NaN; `Math.abs(NaN) < 0.005` is false;
`Math.abs(NaN) >= 0.05` is false; `Math.abs(NaN) >= 0.02` is false ⇒ **falls through to
`TRIVIAL`**. There is **no `Number.isFinite` guard anywhere in `profileMaterialityOf`**.
`+Infinity` yields `STRONG` with a literal `Infinitypp` in the user-facing string.
Relevant caller: `test/profileQuantificationGolden.test.ts:227` passes `a.masses.bluffMass!` — if
that were `undefined`, `bluffMassDelta` becomes NaN, the verdict is TRIVIAL, and the assertion
`verdict !== NO_EFFECT` **still passes** (only the later `Number.isFinite(bluffMassDelta)` check
catches it).

**CONFLICT: YES** — dead thresholds (0.005 / 0.01), and NaN/±Infinity silently produce TRIVIAL/STRONG
instead of an explicit "undefined input" result.

**RESOLUTION**: (i) either wire `equityTrivial`/`massTrivial` into a distinct verdict band or delete
them — a threshold that cannot change any output is a false contract; (ii) add
`if (![equityA, equityB, bluffMassA, bluffMassB].every(Number.isFinite)) return NO_EFFECT` (or a new
`INVALID_INPUT`); (iii) make `noteZh` refuse to print a non-finite delta.

---

## 3. ODDS-RATIO NUMERICS

**CLAIM**: `rateOdds(p) = p/(1−p)` with `p` clamped to [0.001, 0.999]; `cond = rateOdds(rate)/rateOdds(poolPrior)`;
`rate === poolPrior` gives exactly 1.0; the clamp at 1.0 is reported.

### EVIDENCE (`scripts/v21-rev4-odds.ts`)

**(a) Clamp bounds — as declared.**
```text
rateOdds(0)        = 0.0010010010010010009923   (= rateOdds(0.001), 不是 0)
rateOdds(1)        = 998.99999999999909051      (= rateOdds(0.999), 不是 +∞)
rateOdds(0.0001)   = 0.0010010010010010009923
rateOdds(0.9999)   = 998.99999999999909051
rateOdds(-1)       = 0.0010010010010010009923 ; rateOdds(2) = 998.99999999999909051
rateOdds(±Infinity)= 998.99999999999909051 / 0.0010010010010010009923
rateOdds(NaN)      = NaN                        ← NaN 穿透 Math.max/Math.min ⇒ cond = NaN
钳位区间 [0.001, 0.999] ⇒ odds ∈ [0.0010010010010010010, 998.99999999999909]
```

**(b) `rate === poolPrior` ⇒ `cond === 1.0` bit-identical — VERIFIED for every trait and archetype.**
```text
逐位等于 1.0 的 (trait, rate===poolPrior) 组合：8 / 8（0 例外）
逐原型中性验证（traits.effectiveRate 是否逐位等于池先验，且 cond 是否逐位 1）：
  UNKNOWN  priorAvailable=false 逐位中性=Y  riverBluff:=1 riverLargeBetBluff:=1 missedDrawBluff:=1
                                           probeAfterTurnCheckBack:=1 thinValueBet:=1 callTooWide:=1
  TIGHT    priorAvailable=false 逐位中性=Y  （同上，全 1）
  NORMAL   priorAvailable=false 逐位中性=Y  （同上，全 1）
  VERY_LOOSE priorAvailable=false 逐位中性=Y（同上，全 1）
  AGGRESSIVE priorAvailable=false 逐位中性=Y（同上，全 1）
```
`NEUTRAL_ARCHETYPES = {UNKNOWN, NORMAL, TIGHT, VERY_LOOSE, AGGRESSIVE}` — all five give `cond ≡ 1`
bit-exactly for all six traits. This is the structural basis of NEUTRAL_PARITY; it holds.

**(c) Achievable `cond` extremes.**
```text
池先验 = {riverBluff 0.28, riverLargeBetBluff 0.2, missedDrawBluff 0.25,
          probeAfterTurnCheckBack 0.3, thinValueBet 0.35, callTooWide 0.5}
人工读数刻度 = {VERY_LOW 0.05, LOW 0.2, MEDIUM 0.45, HIGH 0.65, VERY_HIGH 0.8}

动态范围（每个 trait，池先验 × 全部可达 rate）：
  riverBluff               cond ∈ [0.13533834586466165,  10.285714285714286]  76.000000000000014×
  riverLargeBetBluff       cond ∈ [0.21052631578947370,  16.000000000000004]  76.000000000000014×
  missedDrawBluff          cond ∈ [0.15789473684210528,  12.000000000000004]  76.000000000000014×
  probeAfterTurnCheckBack  cond ∈ [0.12280701754385966,   9.3333333333333339]  76.000000000000000×
  thinValueBet             cond ∈ [0.097744360902255648,  7.4285714285714306]  76.000000000000014×
  callTooWide              cond ∈ [0.052631578947368425,  4.0000000000000009]  76.000000000000014×

仅「声明先验 + 人工 5 档」：max cond = 16.000000000000004 @ riverLargeBetBluff rate=0.8
                            min cond =  0.052631578947368425 @ callTooWide rate=0.05
                            比值 = 304.00000000000006×
含实测路径的**理论**极值（机会数 → ∞）：max 3995.9999999999964 @ riverLargeBetBluff (rate→0.999)
                                          min    0.0010010010010010010 @ callTooWide (rate→0.001)
                                          比值 = 3992003.9999999963×
实测 1e9/1e9 ⇒ effectiveRate 0.99999999567999998 ⇒ cond 2568.8571428571399（不是 +∞）
实测 0/1e9   ⇒ effectiveRate 1.6799999899200002e-9 ⇒ cond 0.0025740025740025735
```
The report's "≈11×" (V2 report L53, `behaviorProfile.ts:584`) refers to the 0.10→0.55 pair; the
**declared** dynamic range is 76× per trait and 304× across the trait/scale space. Not a conflict —
just a wider number than the prose implies.

**(d) Geometric mean and the clamp at 1.0.**
```text
likelihood  = baseLikelihood × product^(1/slotCount)
slotCount   = max(1, 1 + (bluffClass?1:0) + (bluffClass||thinClass?1:0))  ⇒ 1 或 3
appliedTraitCount === 0 ⇒ combinedAdjustment = 1（硬编码短路）
```
- Can the geometric mean produce `likelihood > 1`? **Yes.**
  - On the full 8-class × 4-size × 3-line × 6-bucket **cross-product** (6336 cells, includes
    semantically impossible pairings): `clamped = 158 (2.49%)`, max `combinedAdjustment` =
    **2.9154784431973675**, max `rawLikelihood` = **2.7697045210374989**
    (`MANIAC/MISSED_FLUSH_DRAW/LARGE/TURN_CHECK_BACK/b0`).
  - On **only the pairs `riverComboClassOf` can actually produce** (1320 cells at betRatio 0.75;
    330 cells at betRatio 3.0): `clamped = 0 / 0`. Max `rawLikelihood = 0.94999999999999996`
    (`UNKNOWN/NUT_VALUE/b0/SMALL`). So at the audited nodes the clamp is inactive.
  - **But with legal real evidence it saturates**: 150/150 observed on three traits ⇒
    `combined = 23.346976`, `raw = 1.2805414` ⇒ `likelihood = 1.0`, `clamped = true`; at 1e6/1e6,
    `raw = 166.38512` ⇒ `1.0`. See §1c.
- **How the clamp is reported**: the returned object carries `{ likelihood, rawLikelihood, clamped,
  baseLikelihood, combinedAdjustment, appliedTraitCount, sizeAdjustment, nodeAdjustment,
  profileAdjustment, contributions, trace, noteZh }`. `clamped = likelihood !== rawLikelihood`.
  The magnitude of the saturation is **not** surfaced in any aggregate field — only `rawLikelihood`
  (which a consumer must know to compare) and, with `withTrace: true`, a `noteZh` fragment.
  The trace denominator is `unified.length` = **990** (all entries, including the 541 with
  `prior = 0` whose posterior is 0 regardless), so `钳位 N/990` **over-counts** relative to actual
  information loss. The hot path runs with `withTrace: false` (`behaviorProfile.ts:665-672`), so the
  note is not even built for the production path.

**CONFLICT: NO.** (a) clamp bounds exact as declared; (b) bit-exact neutral identity holds for every
trait × archetype (8/8, 5/5 neutral archetypes); (c) extremes measured; (d) clamp is reachable only
under extreme-but-legal evidence, and its *flag* is reported correctly — the defect is that the
audit's reader of that flag is dead (§1b).
**Warnings**: NaN passes `rateOdds` unchanged (`Math.max/min` do not filter NaN) ⇒ `cond = NaN` ⇒
`likelihood = NaN`; and the `N/990` denominator conflates "clamped" with "has zero prior".

**RESOLUTION**: add `Number.isFinite(rate)` handling in `rateOdds` (or reject non-finite
`effectiveRate` upstream); report the clamp denominator over reachable (`prior > 0`) combos and add a
numeric `maxSaturationRatio = max(rawLikelihood / 1)` field so the magnitude is machine-readable.

---

## 4. MASS CONSERVATION

**CLAIM**: on the reference hand, class masses + unclassified sum to the reachable mass;
`Σ entries.probability` is as expected after `updateRange`; `bluffMass = missedDrawMass + pureAirMass`;
`valueMass = nut + strong + thin`.

### EVIDENCE (`scripts/v21-rev4-masses.ts`, 4 profiles, golden fixture)

**(a) `Σ 8 class masses + unclassified` vs `totalMass` — conserves only to ~1e-15, NOT bit-exactly.**
```text
画像                 totalMass              Σ 8 类质量             unclassified  Σ类+unclass − totalMass
CALLING_STATION  1.0000000000000040      1.0000000000000036      0              −4.4408920985006262e-16  (−2 ULP)
MANIAC           0.99999999999999778     0.99999999999999889     0              +1.1102230246251565e-15  (+5 ULP)
NORMAL           1.0000000000000047      1.0000000000000036      0              −1.1102230246251565e-15
UNKNOWN          1.0000000000000047      1.0000000000000036      0              −1.1102230246251565e-15
```
Max |Δ| = **1.11e-15** (5 ULP of 1.0). Cause is summation order, not logic: `rangeFacts.ts:230`
accumulates `total += p` **in entry order** over all 449 reachable entries, while `:237`
accumulates `byClass[category] += p` **partitioned by class**. Different association ⇒ different
rounding. `reachableRangeCount = 449` in all four cases.

**(b) `Σ entries.probability` after `updateRange`.**
```text
images        range.metrics.probabilitySum        m.totalMass            Δ vs 1
CALLING_STATION  1.0000000000000040          1.0000000000000040     +3.9968028886505635e-15  (18 ULP)
MANIAC           0.99999999999999778         0.99999999999999778    −2.2204460492503131e-15  (−10 ULP)
NORMAL           1.0000000000000047          1.0000000000000047     +4.6629367034256575e-15
UNKNOWN          1.0000000000000047          1.0000000000000047     +4.6629367034256575e-15
metrics.supportSize=449 = facts.supportSize=449 ; metrics.totalEntries=990 ; collapsed=false
profileRangeEvidence: combosBefore=449  combosAfter=449  （相等 ✔）
```
`m.totalMass` is **bit-identical** to `range.metrics.probabilitySum` in every case — the two are
computed by the same entry-order accumulation over the same entries. But neither is exactly 1: the
deviation is up to **+4.00e-15 (18 ULP)**. `isStableNormalized(1.0000000000000040)` returns `true`
(EPSILON tolerance), so this is inside the declared contract, but "Σp = 1" is only an
epsilon-level claim, not bit-exact.

**(c) `bluffMass = missedDrawMass + pureAirMass` — BIT-EXACT in all four profiles.**
```text
CALLING_STATION  missedDraw 0.0049154445439535737 = missedFlush+Straight+Combo 0.0049154445439535737  Δ=0.0
                 bluff      0.0078459923939692353 = missedDraw+pureAir            0.0078459923939692353 Δ=0.0
MANIAC           missedDraw 0.034028868933016321  = 0.034028868933016321  Δ=0.0
                 bluff      0.050014166325626060  = 0.050014166325626060  Δ=0.0
NORMAL / UNKNOWN missedDraw 0.012016015469874703  = 0.012016015469874703  Δ=0.0
                 bluff      0.018421440058874052  = 0.018421440058874052  Δ=0.0
```

**(d) `valueMass = nut + strong + thin` — BIT-EXACT in all four profiles.**
```text
CALLING_STATION  valueMass 0.41141024748874433 = 0+0.11539219557984051+0.29601805190890385  Δ=0.0
MANIAC           valueMass 0.39399357568227156 = 0+0.10643042563804249+0.28756315004422905  Δ=0.0
NORMAL / UNKNOWN valueMass 0.40672027657599252 = 0+0.11012048706820535+0.29659978950778720  Δ=0.0
```

**Unclassified share = 0 is genuinely correct (not just unreported):** an exhaustive scan of
`riverComboClassOf` over **9900 legal combos across 10 boards** returned `null` **0 times** and
produced only declared categories (§7). `unclassifiedMassShare = 0.0000000000000000` in all four
profiles.

**CONFLICT: NO** (no logic failure). The only deviation is the **order-of-summation** gap in (a),
bounded by 1.11e-15, and the epsilon-level (not bit-exact) `Σp = 1` in (b).
**RESOLUTION**: if an exact identity is desired, derive `totalMass` from the class accumulator
(`Σ byClass + unclassified`) rather than a parallel running sum, or use Kahan/Neumaier summation.

---

## 5. NORMALISATION STABILITY

**CLAIM**: scaling all posterior weights by 1e-300 or 1e300 changes no decision-relevant output, and
no likelihood underflows to exactly 0 in a way that silently deletes combos.

### EVIDENCE (`scripts/v21-rev4-norm-enums.ts`)

**5a. `stableNormalize` is NOT bit-exactly scale invariant.**

| shape | ×1e-300 | ×1e300 | ×1e-308 | ×1e-160 |
|---|---|---|---|---|
| `[1,1,1]` | bit-identical, support 3→3 | bit-identical | bit-identical | bit-identical |
| `[1,1,0.5]` | bit-identical | bit-identical | bit-identical | bit-identical |
| `[1, 1e-12, 1e-300]` | **max diff 1.535e-24, support 3→2** | bit-identical | max diff 1.113e-17, **support 3→2** | max diff 1.000e-300, **support 3→2** |
| 449-item tail | max diff 3.469e-18, support 449→449 | max diff 3.469e-18 | max diff 3.469e-17, Σp 1.0000000000000009→1.0000000000000002 | max diff 3.469e-18 |
| `[1, 5e-324]` | **max diff 4.941e-324, support 2→1** | bit-identical | support 2→1 | support 2→1 |
| `[1, 1e-320]` | **max diff 1.000e-320, support 2→1** | bit-identical | support 2→1 | support 2→1 |

⇒ **Scaling by 1e300 is safe** (rejected cleanly if it overflows:
`[1e300×1e300, 1e300] = [Infinity, 1e300]` ⇒ `RANGE_VALIDATION_FAILED`; `[Infinity, 1]` ⇒
`RANGE_VALIDATION_FAILED`). **Scaling by 1e-300 can (i) change probabilities by up to 3.5e-18 and
(ii) reduce `supportSize`** whenever a scaled weight underflows to exact 0 — i.e. it can silently
delete combos. This is the documented P1 bug class re-entering through the small end rather than the
large end.

**5b. In the log domain (the domain `updateRange` actually uses, `rangeUpdate.ts:480,510`), a
multiplicative scale is an additive shift — and large shifts lose precision.**
```text
shift = −690 : max diff 1.547e-15   Σp 1.0000000000000000 → 0.99999999999998046   support 449→449
shift = −300 : max diff 1.003e-15   Σp → 0.99999999999997957
shift = +300 : max diff 1.003e-15   Σp → 0.99999999999997957
shift = +690 : max diff 1.547e-15   Σp → 0.99999999999998046
shift = ±1e15: max diff 2.152e-3    Σp → 0.95368056002924706
```
Cause: `logWeight + shift` rounds — the ULP at 690 is 1.14e-13. So the engine's scale invariance is
a **1e-15-level** property, not a bit-exact one, and degrades catastrophically for shifts ≥ 1e15.

**5c. Underflow to exactly 0 is silent and indistinguishable from a true 0.**
```text
exp(−745.2)    = 0.0000000000000000  isNumericallyZero=true
exp(−745.1332) = 4.9406564584124654e-324  isNumericallyZero=false   (DENORMAL_MIN)
exp(−750 / −1074 / −1075 / −Infinity) = 0.0000000000000000
normalizeLogWeights([0, −745.2, −800]) ⇒ support=1/3, p=[1, 0, 0], Σp=1.0  ← 无错误、无警告
```
The third entry is deleted and `supportSize` reports `1` instead of `3`. `isNumericallyZero` is
implemented as `probability === 0` (`rangeLogSpace.ts:310-312`), which is **exactly what a true zero
returns**, so it cannot distinguish "真实的 0" from "浮点下溢的 0" as its docstring claims.
`DENORMAL_MIN` is exported but **never used in `src/`**. (`effectiveLogWeight`, listed in the
`rangeLogSpace.ts:37` responsibility table, **does not exist**.)

**5d. End-to-end on the reference hand: no combo deletion.**
```text
combosBefore = 449, combosAfter = 449   (profileRangeEvidence, all profiles)
updateTrace: FLOP/CHECK 449→449 · FLOP/CALL 449→449 · TURN/CHECK 449→449 · RIVER/BET 449→449
supportSize = 449 in both range.metrics and opponentRangeFacts
```
No `p` underflows to 0 in the audited fixture: `range.entries... p<=0 条目数` is not observable, but
`metrics.supportSize = 449 = reachableRangeCount` confirms nothing was dropped.

**CONFLICT: NO** for the audited fixture and for the 1e300 direction. **YES for the literal 1e-300
claim in the sense that matters**: support-set deletion is reachable. On the reference hand it does
not occur.
**RESOLUTION**: change `isNumericallyZero` to `p < DENORMAL_MIN * 2` (or delete it and `DENORMAL_MIN`
if unused); record `underflowedCount` in `stableNormalize`/`normalizeLogWeights` results so a
support-set shrink caused by underflow is visible rather than reported as a legitimate `supportSize`.

---

## 6. TEST TRUSTWORTHINESS

### 6a. Run results (`node --test --experimental-strip-types`, each file in isolation)

| file | pass/fail | duration (ms) | wall (ms) |
|---|---|---|---|
| `test/profileQuantificationGolden.test.ts` | **5 / 0** | 8281.3 | 8970 |
| `test/profileV2Metrics.test.ts` | **6 / 0** | 2066.2 | 2223 |
| `test/profileQuantification.test.ts` | **9 / 0** | 520.7 | 669 |
| `test/profileRangeAdjustment.test.ts` | **14 / 0** | 32019.9 | 32309 |
| `test/riverConsistencyV21.test.ts` | **16 / 0** | 32207.5 | 32549 |
| `test/reportVerdictConsistency.test.ts` | **6 / 0** | 1315.5 | 2457 |
| **combined single invocation** | **56 / 0** | 45397.7 | — |

No EPERM encountered. All six are green.

### 6b. Mutation test — method and safety

I did **not** modify any file under `src/` or `test/`. Instead:
1. Built **isomorphic local copies** of the rule under test and validated them against production on
   the tests' own literal inputs — 12/12 agree, 0 mismatches ⇒ the copies are faithful oracles.
2. Emulated `cond ≡ 1` using **production itself**: every archetype in `NEUTRAL_ARCHETYPES` has
   `priorRate === ENVIRONMENT_BEHAVIOR_PRIOR[key]` bit-exactly, hence `cond ≡ 1.0` bit-exactly (§3b,
   verified). Replacing `CALLING_STATION`/`MANIAC` with `NORMAL` is therefore an exact behavioural
   model of "make `cond` return 1".
3. Emulated "`statEvidenceOf` ignores `opportunities`" using production's own
   `opportunities === 0` branch, which returns `priorRate` bit-exactly.

### 6c. M1 — `cond ≡ 1` (profile silently does nothing)

```text
                       equity                bluffMass              missedDrawMass         valueMass
真实 CALLING_STATION   0.5580798411791583   0.007845992393969235   0.004915444543953574   0.41141024748874433
真实 MANIAC            0.5760913804269139   0.05001416632562606    0.03402886893301632    0.39399357568227156
变异后 A（=NORMAL）    0.5625883726719894   0.018421440058874052   0.012016015469874703   0.4067202765759925
变异后 B（=NORMAL）    0.5625883726719894   0.018421440058874052   0.012016015469874703   0.4067202765759925
```
| assertion | caught? |
|---|---|
| golden §二十 `b.bluffMass > a.bluffMass` | **CAUGHT** (mutant: 0.018421440058874052 > 0.018421440058874052 is false) |
| golden §二十 `b.missedDrawMass > a.missedDrawMass` | **CAUGHT** (mutant: 0.012016015469874703 > 0.012016015469874703) |
| golden §二十 `b.equity > a.equity` | **CAUGHT** (mutant: 0.5625883726719894 > 0.5625883726719894) |
| golden §二十 `b.callEV > a.callEV` | **CAUGHT** (identical equity ⇒ identical EV) |
| profileQuantification §20 `rangeDistance > 0.02` | **CAUGHT** (both sides identical ⇒ distance 0) |
| profileV2Metrics NEUTRAL_PARITY (48 cells) | **MISSED** — it tests the neutral profile, so the mutant makes it trivially true |
| profileV2Metrics §十七 clamp (03A/03B) | **MISSED** — mutant keeps `clamped === false` and `raw ≤ 0.5` |
| profileV2Metrics coverage lock / metrics / distance | **MISSED** — no non-neutral profile involved |
| riverConsistencyV21 (all 16) | **MISSED** — see 6f |
| reportVerdictConsistency (all 6) | **MISSED** — see 6e |

### 6d. M2 — `statEvidenceOf` ignores `opportunities`

```text
测试用例                                     真实 effectiveRate   变异   断言              真实  变异
profileQuantification §33  2/2                 0.43750000      0.25000000  < 0.5           过    过（漏网）
profileQuantification §33 60/100               0.58018868      0.25000000  > 0.55          过    **红**
profileQuantification §33 40/100 vs 2/2        0.39150943      0.25000000  单调            过    **红**
profileQuantification §34 90/100               0.86320755      0.25000000  |r−0.9|<0.06     过    **红**
profileQuantification §30 10 机会 / 4 成功      0.34375000      0.25000000  observedRate===0.4  过  **红**（变异后 observedRate = null）
```
The `2/2 ⇒ effectiveRate < 0.5` assertion passes under the mutant (0.25 < 0.5) — a shrinkage test
that cannot see the loss of shrinkage. The other four catch it.

### 6e. M3 — comparison-operator flips in `profileMaterialityOf` (tests' literal inputs)

| test input | production | `>=`→`<=` (STRONG) | `>=`→`>` (MATERIAL) | `<`→`>` (TRIVIAL) |
|---|---|---|---|---|
| Case A (0.018 / 0.0422) | TRIVIAL | **STRONG ← red** | TRIVIAL | TRIVIAL |
| Case B (equityMaterial / 0) | MATERIAL | **STRONG ← red** | **TRIVIAL ← red** | MATERIAL |
| Case C (0.001 / massMaterial) | MATERIAL | **STRONG ← red** | **TRIVIAL ← red** | MATERIAL |
| Case D (equityMaterial−1e-7 / 0) | TRIVIAL | **STRONG ← red** | TRIVIAL | TRIVIAL |
| Case D (equityMaterial+1e-7 / 0) | MATERIAL | **STRONG ← red** | MATERIAL | MATERIAL |
| Case D (0 / massMaterial) | MATERIAL | **STRONG ← red** | **TRIVIAL ← red** | MATERIAL |
| Case D2 (0 / 0) | TRIVIAL | TRIVIAL | TRIVIAL | TRIVIAL |
| Case D2 (equityTrivial+1e-9 / 0) | TRIVIAL | **STRONG ← red** | TRIVIAL | TRIVIAL |
| golden (0.018 / 0.0195) | TRIVIAL | **STRONG ← red** | TRIVIAL | TRIVIAL |

- The **STRONG** operator flip is caught by 8/12 inputs.
- The **MATERIAL** operator flip is caught only at the *exact-equality* inputs (Case B, Case C,
  Case D's `massMaterial`) — i.e. only because those cases were chosen as boundary-equal.
- The **TRIVIAL lower-bound** flip is caught by **0/12 inputs** — consistent with §2a: those
  thresholds control nothing, so no test can observe a mutation in them.
- M4 (removing the `null` short-circuit): `equityA=null, bluffMassDelta=0.5` gives production
  `NO_EFFECT` vs mutant `MATERIAL` ⇒ visible, but **no test asserts that specific combination**;
  `reportVerdictConsistency` only exercises non-null inputs, and the golden test's
  `verdict !== NO_EFFECT` is satisfied by any non-NO_EFFECT verdict.

### 6f. Per-test judgement: would it FAIL if the profile logic were broken?

| test | catches `cond ≡ 1`? | catches `statEvidenceOf` ignoring opportunities? | catches operator flips? | Verdict |
|---|---|---|---|---|
| `profileQuantificationGolden.test.ts` | **YES** — 4 independent monotonicity assertions on exact (non-sampled) probability mass | no | indirectly (materiality only asserted `!== NO_EFFECT`) | **strong** |
| `profileQuantification.test.ts` | **YES** (`§20/§21` range distance, bluffMass monotonic) | **YES** (§33 60/100, §33 monotonic, §34) | no | **strong** |
| `profileRangeAdjustment.test.ts` | **YES** (T1 equity/CallEV monotonicity across A/B/C, T2, T5 bluff monotonicity) | partly (T8 evidence-priority) | no | **strong** |
| `profileV2Metrics.test.ts` | **NO** — every test is either about the neutral profile or about a large-constant clamp; the mutant satisfies all of them | no | no | **partial** |
| `riverConsistencyV21.test.ts` | **NO** — the file only ever uses `quickProfile: 'NORMAL'` (lines 83, 526), and `NORMAL ∈ NEUTRAL_ARCHETYPES` ⇒ `cond ≡ 1` throughout; the profile path is identically neutral for the whole file | no | no | **cannot lock the profile feature** |
| `reportVerdictConsistency.test.ts` | **NO** — it compares the report's text against `verdictOf(0.018, 0.0422)`, two hard-coded literals; it never measures the hand, so it passes whatever the profile does | no | **YES** for STRONG/MATERIAL flips (Case B/C/D) | **text-consistency only** |

### 6g. Additional trust gap in `reportVerdictConsistency.test.ts`

The file claims to lock "生产计算 == 报告页首 == 报告 §二十五". It does **not** recompute the deltas:
`verdictOf(0.018, 0.0422)` (line 144) hard-codes the numbers the report also hard-codes. If a future
change moves the true equity delta from 0.01801 to 0.02100 (MATERIAL), the report would still say
`TRIVIAL`, the test would still pass, and nothing would notice. It is a **manual-value consistency
gate**, not a measurement gate. Combined with §1f (its helper perturbs boundaries by up to 15 ULP),
this file is the weakest of the six despite being the one explicitly written to prevent
"multiple sources of truth".

**CONFLICT: YES.**
**RESOLUTION**:
1. `riverConsistencyV21.test.ts` should either use a non-neutral archetype in at least one case or
   stop being counted as a profile regression lock.
2. `profileV2Metrics.test.ts` needs one non-neutral end-to-end case (or an assertion that
   `combinedAdjustment ≠ 1` for a non-neutral profile).
3. `reportVerdictConsistency.test.ts` must **recompute** the A/B deltas from the golden fixture
   rather than hard-coding them.
4. Add a test that a legal-but-extreme observed profile (`n ≥ 150` successes on the three bluff
   traits) makes `clamped === true` visible — otherwise the clamp pathway is untested.

---

## 7. THE TWO SAME-NAMED `MEDIUM_VALUE` ENUMS

**CLAIM**: `RiverComboClass.MEDIUM_VALUE` is truly gone (no string member producible), and
`riverComboClassOf` can produce every remaining member of `RiverComboClass` on some board.

### EVIDENCE (`scripts/v21-rev4-norm-enums.ts`)

**7a. `RiverComboClass` is a type-only declaration** (`behaviorProfile.ts:528-536`:
`export type RiverComboClass = 'NUT_VALUE' | … | 'PURE_AIR'`). There is **no runtime object**, so
`RiverComboClass.MEDIUM_VALUE` cannot be evaluated at all (it would be a `ReferenceError`). The only
runtime `MEDIUM_VALUE` in the codebase belongs to a different enum:
```text
RelativeHandRole.MEDIUM_VALUE = "MEDIUM_VALUE"
RelativeHandRole 全部成员 = NUT_VALUE, STRONG_VALUE, MEDIUM_VALUE, THIN_VALUE, BLUFF_CATCHER,
                            DRAW, SEMI_BLUFF, PURE_BLUFF, SHOWDOWN_VALUE, AIR
```
No live `'MEDIUM_VALUE'` string literal is compared against a `RiverComboClass` anywhere in `src/`
(surviving mentions in `contextBuilder.ts:1158`, `decision.types.ts:1300`,
`behaviorProfile.ts:282/510-526`, `relativeHandRole.ts:312-491`, `valueBetGate.ts:250` are comments
or `RelativeHandRole` uses).

**7b. Exhaustive reachability scan: 10 boards × 990 legal combos = 9900 classifications.**
```text
扫描可达组合 9900 个（已排除与公共牌/Hero 重叠的组合）；riverComboClassOf 返回 null = 0
产出 'MEDIUM_VALUE' 字符串的次数 = 0
产出声明之外的类别字符串 = 无
```

**7c. Coverage matrix** (declared members × observed `strengthBucket` × boards producing it):

| `RiverComboClass` member | observed buckets | boards | reachable |
|---|---|---|---|
| `NUT_VALUE` | {0} | 2 / 10 | ✔ |
| `STRONG_VALUE` | {1} | 10 / 10 | ✔ |
| `THIN_VALUE` | {2} | 9 / 10 | ✔ |
| `SHOWDOWN_VALUE` | {1,2,3,4,5} | 10 / 10 | ✔ |
| `MISSED_FLUSH_DRAW` | {5} | 7 / 10 | ✔ |
| `MISSED_STRAIGHT_DRAW` | {5} | 8 / 10 | ✔ |
| `MISSED_COMBO_DRAW` | {5} | 7 / 10 | ✔ |
| `PURE_AIR` | {5} | 8 / 10 | ✔ |

**8 / 8 declared members reachable; 0 undeclared members produced; 0 null classifications.**
The bucket coupling matches the documented `classifyRiverAction` mapping:
`CLEAR_VALUE ∧ tier 0 ⇒ NUT`; `CLEAR_VALUE ∧ tier 1 ⇒ STRONG`; `THIN_VALUE ⇒ tier 2`;
`SHOWDOWN/UNCERTAIN ⇒ SHOWDOWN` (tiers 1–5); `BLUFF_CANDIDATE ⇒ MISSED_* / PURE_AIR` (tier 5).
`NUT_VALUE` requires a paired or straight-flush board (`Ad As 8d 4c 2h`, `7s 6s 5s 4s 2h`) — the
only two of the ten boards that produce it, exactly as `profileV2Metrics.test.ts:121-128` documents.

**CONFLICT: NO.**
**RESOLUTION**: none required. Optional: add a runtime `const RIVER_COMBO_CLASSES = [...] as const`
value alongside the type so that coverage can be asserted without duplicating the member list in the
test (currently the test declares `ALL_RIVER_COMBO_CLASSES` itself at lines 33-43, so adding a member
to the type would not automatically be caught).

---

## APPENDIX — artifacts and reproduction

| probe | what it establishes |
|---|---|
| `scripts/v21-rev4-thresholds.ts` | §1f, §2 (ULP boundaries, dead thresholds, NaN, display contradictions) |
| `scripts/v21-rev4-odds.ts` | §3 (`rateOdds` clamp, bit-exact neutral identity, cond extremes, geometric mean, clamp grids) |
| `scripts/v21-rev4-masses.ts` | §4 (all four conservation identities across 4 profiles) |
| `scripts/v21-rev4-norm-enums.ts` | §5 (scale invariance, log shift, underflow) + §7 (coverage matrix) |
| `scripts/v21-rev4-mutation-emulation.ts` | §6c–6e (M1/M2/M3/M4) |
| `scripts/v21-rev4-clamp-path.ts` | §1b/§1c (fail-open clamp verdict; clamp reachability threshold) |

Environment facts recorded: `node v24.19.0`; `reports/evidence/v21-decision-impact.json` was **absent
at first inspection (18:44) and appeared at 18:49:43** — it was mid-write. The final file
(54 961 bytes) was read for §1b. `reports/evidence/v21-profile-sensitivity.json` (116 693 bytes)
contains only `{meta, corpus}`; the matrix rows that feed the §12 materiality verdict are printed to
stdout and **not persisted**, so the `max |equityDelta| @ row` / `max |bluffMassDelta| @ row` labels
cannot be verified from the artifacts and the "same row?" question in §1a is unresolvable from
evidence.

No file under `src/` or `test/` was modified. `npm run verify` was not run (owned by another agent);
per-file and combined `node --test` were used instead. No EPERM was encountered.
