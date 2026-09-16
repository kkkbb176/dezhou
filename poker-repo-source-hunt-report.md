# Red-Team Source Hunt: "WizGTO" and "CoronaPoker"

Scope: honest, verification-first hunt for two alleged GitHub poker projects.
Every claim below is marked **VERIFIED** (I fetched it and read the content) or
**UNVERIFIED / 未能验证**. Nothing is inferred from a search-result snippet alone.

---

## (A) WizGTO — "poker GTO training tool"

### Found?
**YES — the project exists.** It is obscure (1 star), not a fabrication.

### Identity
| Field | Value | Status |
|---|---|---|
| Full name | `omkarxpatel/wizgto` | VERIFIED (`api.github.com/repos/omkarxpatel/wizgto`) |
| URL | https://github.com/omkarxpatel/wizgto | VERIFIED |
| GitHub description | "A No-Limit Hold'em engine that solves, models opponents, and plays its own hands." | VERIFIED |
| Stars | **1** (watchers 1, subscribers 0, forks 0) | VERIFIED |
| Language | TypeScript (Rust component in `server/`) | VERIFIED |
| Default branch | `main` | VERIFIED |
| Version | `1.9.0` (`package.json` + README badge) | VERIFIED |
| Created / last push | `2026-07-23` / `2026-08-18` (per API) | VERIFIED as returned |
| Homepage / topics | empty / none | VERIFIED |
| Repo visibility | public, not archived, not a fork, not a template | VERIFIED |

Search coverage: `api.github.com/search/repositories?q=WizGTO` → `total_count: 1`.
Re-run with `q=wizgto+fork:true` → still `total_count: 1`. **There is exactly one
such repository on GitHub** (as of this search).

### License — EXACT STRING
**Apache License, Version 2.0** — VERIFIED by reading the LICENSE blob itself
(`raw.githubusercontent.com/omkarxpatel/wizgto/main/LICENSE`, HTTP 200, 11,341 bytes).
The appendix reads verbatim:

```
   Copyright 2026 Omkar Patel

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0
```

Corroborated three ways: GitHub API `license.spdx_id: "Apache-2.0"`; README badge
`license-Apache%202.0`; full Apache-2.0 body present in the file.
(First fetch attempt of this URL returned a transport error; the retry succeeded.)

### Directory structure — VERIFIED
From `git/trees/main?recursive=1` (`truncated: false`), so this is the complete tree:

```
.claude/settings.json
.gitignore
CHANGELOG.md              (120,295 bytes)
CLAUDE.md
LICENSE                   (11,341 bytes)
README.md                 (13,126 bytes)
package.json / package-lock.json / tsconfig.json
build.mjs / test.mjs
bots/hu/                  .dockerignore, Dockerfile, README.md, build.mjs,
                          entry.cjs, mock-match.mjs,
                          src/{engine,log,opponent,range,strategy,
                               strategy.test,strength,table}.ts
docs/                     ARCHITECTURE.md, CONTEXT.md (35 KB), HANDOFF.md,
                          ROADMAP.md, SOLVER_API.md
docs/media/               editor-clip.gif, players.png, preflop-charts.png,
                          trainer-clip.gif, trainer-table.png
docs/plans/               TRACK_A_SHOWDOWN_SIZING.md, TRACK_B_POSITIONAL_LEDGER_META.md
eval/                     arena-logs.mjs, corpus-stats.mjs, corpus.mjs,
                          pokerbench.mjs, pokerbench-postflop.mjs,
                          predictor-deps.mts, score-predictor.mjs,
                          slumbot-deps.mts, slumbot.mjs, sweep.mjs
extension/                dashboard.html, manifest.json,
                          src/background/service-worker.ts
                          src/content/{advice,adviceCard,captureStore,handTracker,
                                       index,logPoller,multiway,overlay,ploAdvice,
                                       positions,postflop,prefs,railView,rangeModel,
                                       runtime,scraper,seatBadges,selectors,
                                       solverClient}.ts (+ .test.ts files)
                          src/dashboard/{analyze,charts,corpus,duoCheck,
                                       handEconomics,importLog,index,leaks,ledger,
                                       meta,moneyView,opponentModel,positional,
                                       posteriorScore,postflopReview,rangeAccuracy,
                                       sizingTells,styleGuide,textures,trainer}.ts
                          src/gto/{charts,combos,engine,exploit,nlheEval,omaha,
                                   overrides,postflopBaselines,rangeGrid,ranges}.ts
                          src/shared/{playerTypes,solverTypes,types,version}.ts
server/                   Cargo.toml, Cargo.lock, README.md,
                          fetch-ci-cache.sh, install-launchd.sh,
                          make-cache-config.mjs, overnight-ci.sh, test.sh,
                          src/{cache.rs (62 KB), main.rs (35 KB), solver.rs}
```

### Main features (as claimed in README — NOT independently executed)
- Four surfaces over one engine: (1) autonomous heads-up **arena bot**, (2) **practice
  trainer** sparring against models of real players, (3) **analysis dashboard**
  (leak detection, hand review, charts, solver explorer), (4) live **study overlay**.
- Local **Rust postflop solver** service wrapping `b-inary/postflop-solver`; street-rooted
  sessions; 2% target exploitability / 300 iterations default; 16-bit compressed
  storage above 1 GiB trees; precomputed flop cache.
- **Opponent modelling** from captured hands: VPIP/PFR/3-bet, c-bet & barrel
  frequencies, fold-vs-c-bet, WTSD, sizing & timing tells; shrinkage toward baselines
  with provenance labels; range posterior scored against real showdowns.
- Self-reported metrics: **1.83× geometric-mean lift** over a static prior across
  1,021/1,023 scored showdowns; **96.6%** preflop-chart agreement vs PokerBench;
  bot decision **<250 ms**; **171 tests** passing; strict TS typecheck.
- Formats: NLHE (preflop chart-based; postflop solver), multiway as a *labeled*
  approximation, PLO4/PLO5 Monte-Carlo equity only; explicit "not charted" honesty UI.
- Arena packaging: Docker image for `linux/amd64`, no network egress, 256 MB,
  2000 ms per decision, 200 MB image cap (55.6 MB actual per README).

### Notable technical observations
1. **The arena is a third party, not WizGTO.** `package.json` devDependency is
   `"@chipzen-ai/bot": "^0.3.0"`, and the mock-match env vars are `CHIPZEN_WS_URL`,
   `CHIPZEN_TOKEN`, `CHIPZEN_MATCH_ID` (image tag `wizgto-hu:amd64`). So "ranked
   matches against other people's bots" runs on a **ChipZen** platform. VERIFIED.
2. **Ethics caveat is explicit in the README.** It states real-time assistance is
   against PokerNow's terms and "is cheating in any game against strangers or for
   stakes", restricting that surface to consenting private tables and self-review.
   The other three surfaces are stated to carry no such caveat. VERIFIED (README text).
3. **Solver cannot play live**: uploaded bots get no egress and 256 MB, versus
   20–35 s and ~1 GB per flop for the solver — so the solver "stays an offline oracle."
   VERIFIED (README text).
4. **`CHANGELOG.md` is 120 KB** for a repo created 2026-07-23 — heavy AI-assisted
   development cadence is plausible; `.claude/settings.json` and `CLAUDE.md` are
   present, confirming Claude Code tooling is in-repo. VERIFIED (file listing only;
   I did not read the changelog).

### Description mismatch (important)
The task described WizGTO as a **"poker GTO training tool."** The project's own
one-line description is **an engine that "solves, models opponents, and plays its
own hands."** A trainer is only **one of four** surfaces. So the label is
*partially* right but understates and mis-centres the project. No source was found
making the exact phrase "poker GTO training tool" about this repo — 未能验证.

### Could NOT verify for (A)
- **No independent execution.** All performance claims (1.83× lift, 96.6% PokerBench,
  171 tests, <250 ms) are **self-reported by the README**; I ran no code. 未能验证.
- Whether LICENSE applies uniformly to subdirectories (e.g. `server/`, `bots/hu/`)
  — I read the root LICENSE only. 未能验证.
- **GitHub code search** (which would confirm "personality"/"opponent model" strings
  in source) requires authentication; not available. 未能验证.
- Tags/releases beyond the `1.9.0` string in `package.json`. 未能验证.
- Contents of `CHANGELOG.md`, `docs/CONTEXT.md`, `docs/ARCHITECTURE.md`, and all
  `.ts`/`.rs` sources — features above rest on README + file listing. 未能验证.
- The GitHub **HTML** search page (`github.com/search?q=WizGTO&type=repositories`)
  returned HTTP 200 but **only navigation boilerplate — zero result rows**; results
  are client-rendered. It provided no evidence either way. 未能验证.

---

## (B) CoronaPoker — "poker AI / player personality modelling"

### Found?
**YES — but the name maps to THREE different repos, and the description given is
only half-true for one of them.**

The GitHub API `q=coronapoker` search returns `total_count: 3`:

| # | Repo | Desc (API) | Stars | Lang | License (API) | Created |
|---|---|---|---|---|---|---|
| 1 | **`tonikelope/coronapoker`** | "In many ways, the poker game we always deserved." | **22** | Java | GPL-3.0 (detected) | 2020-08-12 |
| 2 | `derek28/coronapoker` | "Texas Hold'em AI by Bill and Kai, created during the epidemic" | 2 | C++ | **null / none** | 2020-03-31 |
| 3 | `joycollector/coronapoker` | "coronapoker" | 0 | JavaScript | **null / none** | 2020-04-13 |

**The FreeBSD-ports hypothesis resolves to #1**: FreshPorts `games/coronapoker`
lists WWW `https://github.com/tonikelope/coronapoker` and links to the same repo.

### B-1. `tonikelope/coronapoker` (the substantive one)

| Field | Value | Status |
|---|---|---|
| URL | https://github.com/tonikelope/coronapoker | VERIFIED |
| Description | "In many ways, the poker game we always deserved." | VERIFIED |
| Stars | **22** (watchers 22, forks 2, subscribers 2) | VERIFIED |
| Language | Java (Java 17+ required) | VERIFIED |
| Default branch | `master` | VERIFIED |
| Version | `24.10` in `pom.xml` (`com.tonikelope:CoronaPoker`, mainClass `com.tonikelope.coronapoker.Init`) | VERIFIED |
| Topics | dleq-proof, ecdh, ed25519, java, linux, macos, mental-poker, p2p, poker, ristretto255, sra, texas-holdem, windows, zero-trust, zero-trust-architecture | VERIFIED |
| Last push | `2026-08-26` (per API) | VERIFIED as returned |

**License — EXACT STRING:**
```
                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007
```
**VERIFIED** by fetching `raw.githubusercontent.com/tonikelope/coronapoker/master/LICENSE`
(HTTP 200, 35,151 bytes) and reading the full GPLv3 body. Independently corroborated
by FreshPorts, which records `License: GPLv3` and ships
`/usr/local/share/licenses/coronapoker-20.28/GPLv3`. README badge: `License-GPLv3`.

**Directory structure — VERIFIED** (top level via `contents/` API):
```
.github/            CONTRIBUTORS.md     LICENSE (35 KB)     README.md (27 KB)
.mvn/               .gitignore          coronaupdater.jar   coronaupdater/
docs/               pom.xml             robert_rules.pdf    src/     tools/
```
`tools/qa` is a separate Maven module (never packaged in the game JAR);
`tools/reactor` is an opt-in aggregator. VERIFIED (README + contents listing).
I did **not** enumerate the full recursive tree of `src/` — 未能验证 at file level,
though `docs/BOTS.md` names `src/main/java/com/tonikelope/coronapoker/Bot.java`
plus `bot/eval/` and `bot/context/` packages, and `org.alberta.poker.*`.

**Main features (README, not executed):**
- **Zero-trust deck protocol**: commutative Mental Poker (SRA) over Ristretto255 with
  zero-knowledge **Bayer-Groth verifiable shuffle** and DLEQ-chained dealing; host
  cannot peek/duplicate/relocate cards; hole cards sealed to showdown.
- **Ed25519 per-nick identity**, signed action domains, `H_{t+1} = SHA-256(record || sig)`
  hash chain, exact-cent conservation checks and signed closing receipts; TOFU keys.
- **AES-256-CBC + HMAC-SHA256** E2E channels over ECDH; `ObjectInputFilter` whitelist
  on the recovery payload reader.
- Peer-hosted P2P, UPnP port mapping, SQLite crash recovery, reconnect grace windows,
  late-joiner observer mode, anti-flood chat.
- Full NLHE rules incl. side pots, dead button, ante, voluntary straddle, Run It Twice,
  rabbit hunting, IWTSTH; Robert's Rules compliance table with two declared house rules.
- Bots, chat/voice (push-to-record WAV), avatars, stats, MOD packs, i18n (EN/ES).
- Stack: Java 17+, Swing/Matisse, Maven fat JAR, Alberta hand evaluator,
  sqlite-jdbc 3.51.1.0, jfreechart 1.5.5, JNA.

**On the "player personality modelling" claim — this is the crux, and it is
PARTLY TRUE.** I fetched `docs/BOTS.md` (HTTP 200) and it contains a section
**§4 "Personality model"** verbatim. VERIFIED:
- Three axes: **Difficulty** (EASY/MEDIUM/HARD) × **Skill** (RECREATIONAL/REGULAR/SHARK)
  × **Profile** (**NIT / STATION / TAG / LAG**), rolled in a cascade
  (skill from difficulty, profile from skill).
- Documented skill mixes per difficulty (EASY 60/32/8, MEDIUM 25/55/20, HARD 0/35/65).
- **"Profile elasticity"** (`adjustProfileElasticity`) adapting profile per hand by
  stack depth (M-ratio) and **tilt**: short stack collapses to push/fold TAG,
  deep-stacked NIT loosens to TAG, a tilted recreational flips to LAG.
- **`OpponentTracker`** per opponent in a session-wide `TRACKER_MEMORY` map:
  VPIP / PFR / AF, derived `isStation()` / `isNit()` / `isManiac()` reads after >10
  hands, plus an early `looksPassiveStation()` read (≥3 post-flop calls, zero aggression).
- Explicit self-characterisation: **"The bot is a hand-crafted heuristic, not a solver.
  It does not run CFR and it does not compute equity against per-opponent ranges."**
  Its stated ceiling is an "elite heuristic whose primary axis is *feeling human*."
- Calibrated mistake injection: HARD 0% / MEDIUM 22% / EASY 45%; river bluff frequency
  HARD 38% / MEDIUM 14% / EASY 0%.

**EXPLICIT VERDICT on the description.** CoronaPoker #1 is **first and foremost a
peer-to-peer Texas Hold'em *game*** with a cryptographic anti-cheat core. It is
**NOT** a "poker AI / player personality modelling" *research* project, and its
personality model is a **bot-opponent subsystem inside the game**, documented at
`docs/BOTS.md`, not the repository's purpose or headline. Calling the repo
"poker AI / player personality modelling" is **materially misleading as a primary
description**, though — contrary to the task's suspicion that it might be "just a
Texas Holdem game / bot game and NOT a personality-modelling poker AI" — the
personality model is **real, named, and documented**, not invented. Both the
suspicion and the label are partly wrong.

**Notable technical / security observation (significant):**
The **FreeBSD port `games/coronapoker` was DELETED on 2026-04-25** — VERIFIED at
`https://www.freshports.org/games/coronapoker`. The Port Moves record states:

> port deleted on 2026-04-25
> REASON: Remove for security concerns: downloads closed source binary modules,
> should not be restored unless https://github.com/tonikelope/coronapoker/issues/7
> is addressed

The port's `pkg-message` explains that CoronaPoker included **"Panoptes, a
closed-source cryptographic anti-cheat engine"** which the port had attempted to
download at runtime from GitHub, cache to `~/.coronapoker/Panoptes/` and load via
JNI — a GPLv3 violation; the port was patched to disable remote binary downloads and
native loading, at the cost of no tamper detection / no action-blockchain
verification / no post-game auditing. VERIFIED (FreshPorts text).
Port history: added 2020-09-05 (maintainer `yuri@FreeBSD.org`), last update
2026-04-25, versions up to **20.28** — while upstream `pom.xml` is now **24.10**, so
the port had fallen well behind. VERIFIED.

**Discrepancy I could NOT resolve:** the current README advertises a pure-Java
SRA/Ristretto255 implementation with "no native crypto dependencies", which reads as
consistent with Panoptes having been removed — but I **could not verify whether,
when, or how Panoptes was removed upstream**, nor read issue #7. VERIFIED only that
the port was deleted for the stated reason. 未能验证.

### B-2. `derek28/coronapoker` (the "AI" one)

| Field | Value | Status |
|---|---|---|
| URL | https://github.com/derek28/coronapoker | VERIFIED |
| Description | "Texas Hold'em AI by Bill and Kai, created during the epidemic" | VERIFIED |
| Stars | **2** (forks 1) | VERIFIED |
| Language | C++ | VERIFIED |
| License | **none — `license: null` in the API, and no LICENSE file in the tree** | VERIFIED |
| Created / last push | 2020-03-31 / **2020-06-28** (dormant) | VERIFIED |

README (VERIFIED, full text read): "Highly efficient Texas Hold'em simulation
framework, with AI created during the great COVID-19 epidemic, by JWang925 and Kai."
Run `./humanvsbot <numberofhands>`, optional Qt `./PokerGUI`. Extend by deriving from
base class `Player` (see `RandomPlayer`). Known limitations stated by the author:
**"Only headsup is functional"**; multiway needs better pot-size raise computation
and side pots; each hand must start with 100bb.

Directory structure — VERIFIED via recursive tree: `card.{cpp,h}`, `deck.{cpp,h}`,
`pokerhand.{cpp,h}`, `strength.{cpp,h}`, **`ehs_player.{cpp,h}`**,
`human_player.{cpp,h}`, `random_player.{cpp,h}`, `player.{cpp,h}`, `game.{cpp,h}`,
`game_state.h`, `misc.{cpp,h}`, `server.{cpp,h}`, `benchmark.cpp`, `test.cpp`,
`main.cpp`, `humanvsbot.cpp`, `Makefile`, `FEATURETOADD.md`, and
**`nn_weights/{weight1.txt (120 KB), weight2.txt (131 KB), weight3.txt}`**
plus `PokerGUI/` (Qt `.pro`, `mainwindow.*`, `bmp/*.svg` card assets).
`ehs_player` = Expected Hand Strength player, backed by the `nn_weights` blobs.

**Personality modelling in B-2: NONE observed.** No personality/profile/tilt code or
documentation appears in the README or file listing. The AI is an EHS + neural-net
heads-up agent. 未能验证 any personality component.

### B-3. `joycollector/coronapoker`
0 stars, JavaScript, no license, description literally "coronapoker", 12 open issues,
created 2020-04-13, last pushed 2023-01-06. API metadata only — **contents not
inspected. 未能验证.**

### Could NOT verify for (B)
- **No execution / no build.** All rules, crypto and bot claims are README/`docs`
  assertions I read but did not run or cryptographically audit. 未能验证.
- Whether the Bayes-Groth shuffle, DLEQ proofs, receipt consensus or the
  "no native crypto dependencies" claim hold in the actual source. 未能验证.
- Issue #7 contents (`github.com/tonikelope/coronapoker/issues/7`) and the exact
  current Panoptes status upstream. 未能验证.
- Full recursive file tree of `tonikelope/coronapoker` `src/` (only top level + the
  paths named in `docs/BOTS.md`). 未能验证.
- Contents of `joycollector/coronapoker`. 未能验证.
- Any independent third-party review of CoronaPoker bot strength; the
  `HARD > MEDIUM > EASY` gate and 10,000-hands/matchup benchmarks are
  **self-reported in `docs/BOTS.md`**. 未能验证.
- The GitHub **HTML** search page (`github.com/search?q=coronapoker&type=repositories`)
  returned HTTP 200 with **only navigation boilerplate, zero result rows** (JS-rendered).
  No evidence obtained. 未能验证.

---

## Cross-cutting: the "confusion with GTO Wizard" hypothesis

Partly resolved:
- **WizGTO is a real, separate, tiny repo** — it is *not* GTO Wizard. VERIFIED.
- **GTO Wizard is a commercial SaaS** — `https://gtowizard.com/` fetched (HTTP 200):
  paid product ("Get 10% off your first purchase", "Go to App" login wall), markets
  "GTO Wizard AI" solver, trainer, analyser and PokerArena heads-up play. No
  open-source repository was surfaced by any search I ran. VERIFIED that it is
  commercial/closed; **未能验证** the stronger claim that no GTO Wizard OSS repo
  exists, because my final confirming API call
  (`api.github.com/search/repositories?q=gtowizard`) returned
  **HTTP 403 — "API rate limit exceeded"** (unauthenticated limit) and I could not
  re-run it.

## Closest other candidates actually found (for context)
From `q=poker+gto+trainer&sort=stars&order=desc` (90 results; I read only the top
~10 before the response truncated):
- `Jotaeme961/gto-poker-solver-arena` — 55 stars, HTML, **no license**, desc
  "Best GTO Poker Trainer Open Source AI Engine 2026", topics gto/poker/preflop/
  react/texas-holdem/trainer/vite. Created 2026-08-25. High stars for 3 weeks old.
- `jlipton04/poker-utils-webapp` — 5 stars, TypeScript, GPL-3.0, "GTO Preflop Trainer".
- `shewmingg/pokerAI` — 3 stars, Go, GPL-3.0, "use AI to train a GTO player".
- `Rizehigh/gto-preflop-trainer` — 1 star, TypeScript, MIT.
- `doublexmax/gto-trainer`, `Btrya/poker-gto-trainer`, `laurenlev10/gto-poker-trainer`,
  `gbainwol/GTO_PokerTrainer`, `SteveJustin1963/game-tools-poker-dan` — 0–1 star each,
  mostly unlicensed. Metadata only; contents not inspected.

---

## Complete list of URLs actually fetched

**GitHub REST API (all HTTP 200 unless noted)**
1. `https://api.github.com/search/repositories?q=WizGTO`
2. `https://api.github.com/search/repositories?q=coronapoker`
3. `https://api.github.com/search/repositories?q=poker+gto+trainer&sort=stars&order=desc` (truncated)
4. `https://api.github.com/search/repositories?q=wizgto+fork:true`
5. `https://api.github.com/repos/omkarxpatel/wizgto`
6. `https://api.github.com/repos/omkarxpatel/wizgto/git/trees/main?recursive=1`
7. `https://api.github.com/repos/tonikelope/coronapoker/contents/`
8. `https://api.github.com/repos/derek28/coronapoker`
9. `https://api.github.com/repos/derek28/coronapoker/git/trees/master?recursive=1`
10. `https://api.github.com/search/repositories?q=gtowizard` — **HTTP 403, rate limited**

**raw.githubusercontent.com (all HTTP 200 unless noted)**
11. `https://raw.githubusercontent.com/omkarxpatel/wizgto/main/README.md`
12. `https://raw.githubusercontent.com/omkarxpatel/wizgto/main/LICENSE`
    (first attempt: transport error "fetch failed"; **retry: HTTP 200**)
13. `https://raw.githubusercontent.com/omkarxpatel/wizgto/main/package.json`
14. `https://raw.githubusercontent.com/tonikelope/coronapoker/master/README.md`
15. `https://raw.githubusercontent.com/tonikelope/coronapoker/master/LICENSE`
16. `https://raw.githubusercontent.com/tonikelope/coronapoker/master/docs/BOTS.md`
17. `https://raw.githubusercontent.com/tonikelope/coronapoker/master/pom.xml`
18. `https://raw.githubusercontent.com/derek28/coronapoker/master/README.md`

**HTML pages**
19. `https://github.com/search?q=WizGTO&type=repositories` — HTTP 200, **no result rows**
20. `https://github.com/search?q=coronapoker&type=repositories` — HTTP 200, **no result rows**
21. `https://www.freshports.org/games/coronapoker` — HTTP 200, full port record
22. `https://gtowizard.com/` — HTTP 200

**web_search queries used** (via the search tool): `"WizGTO" poker`;
`WizGTO github GTO training tool`; `CoronaPoker github Texas Holdem`;
`"CoronaPoker" AI poker personality`; `GTO Wizard official site commercial poker
training SaaS`; `github "wizgto" OR "WizGTO" poker training tool repository`;
`tonikelope coronapoker bot personality model review`.

## Bottom line
- **(A) WizGTO: FOUND** → `omkarxpatel/wizgto`, 1 star, TypeScript+Rust,
  **Apache License 2.0 (verified by reading the file)**, v1.9.0. It is an
  engine/arena-bot/trainer/dashboard, not narrowly a "training tool". All quality
  metrics are self-reported and unexecuted by me.
- **(B) CoronaPoker: FOUND, three repos.** The FreeBSD-ports one is
  `tonikelope/coronapoker`, 22 stars, Java, **GNU GPL v3 (verified by reading the
  file)**, v24.10 — a peer-to-peer mental-poker Texas Hold'em **game**. Its
  "personality model" is **real and documented** (`docs/BOTS.md`) but is a
  **bot-opponent subsystem**, not the project's purpose — so "poker AI / player
  personality modelling" is a **misleading primary description**. The FreeBSD port
  was **deleted 2026-04-25 over a closed-source JNI anti-cheat ("Panoptes") that
  violated GPLv3**. The genuinely "AI" repo of that name is `derek28/coronapoker`
  (2 stars, C++, **unlicensed**), which has **no** personality modelling.
