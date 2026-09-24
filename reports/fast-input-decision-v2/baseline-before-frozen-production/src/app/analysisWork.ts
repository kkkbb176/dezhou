/** Worker boundary only: preserves the existing pipeline and shadow-analysis options. */
import { analyzeManualHand, type AnalyzeOptions } from './alphaPipeline.ts';
import type { ManualHandInput } from './manualInput/manualInput.ts';
import type { PokerTableState } from './table/table.types.ts';
import { defaultHistoryDir } from './table/playerHistory.ts';
import { runTableDynamicsForTable, tableDynamicsModeFromEnv, tableDynamicsModeZh, SHADOW_BUDGET_MS } from './table/tableDynamicsServer.ts';

export type AnalysisWork = {
  input: ManualHandInput;
  options: Pick<AnalyzeOptions, 'rules' | 'asOf' | 'gtoRanges' | 'logPath' | 'writeLog'>;
  table: PokerTableState | null;
};

export function computeAnalysisWork(work: AnalysisWork) {
  const { input, options, table } = work;
  const result = analyzeManualHand(input, options);
  if (!result.ok) return { result, tableDynamics: null };
  const { rules } = options;
  const tableDynamics = table === null
    ? {
        mode: tableDynamicsModeFromEnv(), status: 'NOT_APPLICABLE',
        summaryZh: '仅牌桌路径支持桌况分析', observing: true,
        tableConfidence: 0, confidenceZh: '样本不足', handsObserved: 0, recordsUsed: 0,
        dimensions: [], relevantPlayers: [], adjustments: [], comparison: null,
        appliedChanges: [], dynamicsDigest: 'n/a',
        reasonZh: '本次是**表单路径**（没有座位与人数事实）⇒ 不做桌况调整',
        coverageZh: '（不适用）', logIssueZh: null,
        modeZh: tableDynamicsModeZh(tableDynamicsModeFromEnv()),
      }
    : {
        ...runTableDynamicsForTable({
          table, input,
          analyze: (inp: ManualHandInput) => analyzeManualHand(inp, { rules, asOf: Date.now() }),
          withBudget: (_analyze: (i: ManualHandInput) => unknown, ms: number) =>
            (i: ManualHandInput) => analyzeManualHand(i, {
              rules, asOf: Date.now(), budget: { softMs: ms, hardMs: Math.round(ms * 1.6) },
            }),
          historyDir: defaultHistoryDir(), shadowBudgetMs: SHADOW_BUDGET_MS,
        }).status,
        modeZh: tableDynamicsModeZh(tableDynamicsModeFromEnv()),
      };
  return { result, tableDynamics };
}

export type AnalysisWorkResult = ReturnType<typeof computeAnalysisWork>;
