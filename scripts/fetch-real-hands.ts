/*
 * 下载**真实牌局**（第三方数据集）到 `third_party/phh-dataset/`。
 *
 * ## 数据来源与许可
 *
 * | 项 | 值 |
 * |---|---|
 * | 仓库 | `github.com/uoftcprg/phh-dataset`（University of Toronto CPRG） |
 * | 许可 | **MIT**（见该仓库 `LICENSE`） |
 * | 格式 | **PHH**（Poker Hand History，该组论文 `arXiv:2312.11753` 定义的格式） |
 * | 本文用到的子集 | `data/pluribus/` —— Pluribus 在 2019 年与职业牌手打的 **6-max NLHE**，$50/$100，100BB |
 *
 * ## 为什么用 Pluribus 这一份
 *
 * **每手牌 6 个玩家的底牌都是已知的**（`d dh pN XxYy`，发牌时就公开记录）。
 * 这一点是硬要求：引擎要给出的「这手怎么打」的建议，只有在**知道所有底牌**时
 * 才能被检验 —— 否则连「他拿什么」都不知道，只能凭空猜。
 *
 * ## 为什么不入库
 *
 * 见 `.gitignore` 的 `third_party/` 段：第三方数据 + 含具体底牌与玩家显示名。
 * 复现方式就是这个脚本。
 *
 * ## 用法
 *
 * ```powershell
 * node --experimental-strip-types scripts/fetch-real-hands.ts --dirs 100,101,102 --per-dir 40
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = 'https://raw.githubusercontent.com/uoftcprg/phh-dataset/main';
const OUT_ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

type Args = { dirs: string[]; perDir: number; force: boolean };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const dirsRaw = get('--dirs') ?? '100,101,102,103,104';
  return {
    dirs: dirsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    perDir: Number(get('--per-dir') ?? '40'),
    force: argv.includes('--force'),
  };
}

/**
 * 单次下载，**失败重试**。
 *
 * 实测这个域名偶发 SSL 握手失败（`The SSL connection could not be established`），
 * 重试即可 —— 不是 404，不是内容问题。
 */
async function fetchText(url: string, attempts = 4): Promise<string | null> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      if (i === attempts - 1) {
        console.log(`   ✖ 放弃 ${url}（${error instanceof Error ? error.message : String(error)}）`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  return null;
}

/**
 * 列出某个目录里的 `.phh` 文件名。
 *
 * ⚠️ 不能用 GitHub Contents API：未认证时限流 403（实测踩到）。
 * 仓库页面 HTML 里内嵌了同样的目录清单 ⇒ 用页面解析，稳定且无需 token。
 */
async function listDir(dirPath: string): Promise<string[]> {
  const html = await fetchText(`https://github.com/uoftcprg/phh-dataset/tree/main/${dirPath}`);
  if (html === null) return [];
  const names = new Set<string>();
  const re = new RegExp(String.raw`"name":"([^"]{1,80}\.phh)","path":"${dirPath.replace(/[/\\]/g, '\\/')}\/([^"]{1,80}\.phh)","contentType":"file"`, 'g');
  for (const m of html.matchAll(re)) names.add(m[2]!);
  /** 页面只渲染前若干项时退化为「按序号猜文件名」（Pluribus 目录就是 `0.phh` `1.phh` …） */
  return [...names];
}

async function main(): Promise<void> {
  const args = parseArgs();
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log(`输出目录：${OUT_ROOT}`);
  console.log(`目标：${args.dirs.length} 个目录 × 每目录 ${args.perDir} 手\n`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const dir of args.dirs) {
    const remoteDir = `data/pluribus/${dir}`;
    const localDir = join(OUT_ROOT, dir);
    mkdirSync(localDir, { recursive: true });

    const listed = await listDir(remoteDir);
    /*
     * 页面只渲染前 50 项左右；Pluribus 的文件名是连续整数
     *（实测 `data/pluribus/100/0.phh`、`1.phh`、`10.phh`…），
     * 因此用「清单 ∪ 0..perDir 序号」作为候选，取够即止。
     */
    const candidates = new Set<string>(listed);
    for (let i = 0; i < args.perDir * 3; i += 1) candidates.add(`${i}.phh`);

    const sorted = [...candidates].sort((a, b) => Number(a.replace('.phh', '')) - Number(b.replace('.phh', '')));
    let got = 0;
    for (const name of sorted) {
      if (got >= args.perDir) break;
      const local = join(localDir, name);
      if (!args.force && existsSync(local)) {
        skipped += 1;
        got += 1;
        continue;
      }
      const text = await fetchText(`${RAW}/${remoteDir}/${name}`);
      if (text === null) {
        failed += 1;
        continue;
      }
      /* 只接受 NLHE（`variant = 'NT'`）—— 本引擎只做无限注德州 */
      if (!/variant\s*=\s*'NT'/.test(text)) continue;
      writeFileSync(local, text, 'utf8');
      downloaded += 1;
      got += 1;
    }
    console.log(`  ${dir}：拿到 ${got} 手（累计下载 ${downloaded}，跳过已存在 ${skipped}，失败 ${failed}）`);
  }

  /* 汇总：确认真的拿到牌局，而不是「下载了一堆 404 页面」 */
  let total = 0;
  const { readdirSync } = await import('node:fs');
  for (const dir of args.dirs) {
    const d = join(OUT_ROOT, dir);
    if (!existsSync(d)) continue;
    const n = readdirSync(d).filter((f) => f.endsWith('.phh')).length;
    total += n;
  }
  const sample = readFileSync(
    join(OUT_ROOT, args.dirs[0]!, readdirSync(join(OUT_ROOT, args.dirs[0]!)).filter((f) => f.endsWith('.phh'))[0]!),
    'utf8',
  );
  console.log(`\n合计落盘 ${total} 手；样本首行：${sample.split('\n')[0]}`);
}

await main();
