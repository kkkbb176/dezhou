/**
 * CLI 输出原语（纯格式化，无业务逻辑）
 *
 * 职责：把结构化数据渲染成终端文本。**不含任何扑克规则、不读取任何牌局状态。**
 */

const WIDTH = 76;

/** 分隔线 */
export function line(char = '─'): string {
  return char.repeat(WIDTH);
}

/** 主标题（双线框） */
export function title(text: string): void {
  console.log('');
  console.log(line('═'));
  console.log(`  ${text}`);
  console.log(line('═'));
}

/** 小节标题（单线） */
export function section(text: string): void {
  console.log('');
  console.log(`【${text}】`);
  console.log(line());
}

/** 键值行：  label：value */
export function bullet(label: string, value: string): void {
  console.log(`  ${label}：${value}`);
}

/** 缩进正文 */
export function note(text: string, indent = 6): void {
  console.log(`${' '.repeat(indent)}${text}`);
}

/** 空行 */
export function blank(): void {
  console.log('');
}

/**
 * 固定列宽的键值行（用于对齐的表格化输出）。
 * @param columns [标签, 值, ...附加列] —— 每列会按给定宽度左对齐
 */
export function columns(cells: readonly string[], widths: readonly number[]): void {
  let out = '  ';
  for (let i = 0; i < cells.length; i++) {
    const width = widths[i] ?? 0;
    out += (cells[i] ?? '').padEnd(width);
  }
  console.log(out.trimEnd());
}

export const COLUMN_WIDTH = WIDTH;
