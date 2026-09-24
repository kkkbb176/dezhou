import { createHash } from 'node:crypto';
import type { TableApiResponse } from './table/tableApi.ts';

/** Transport retry receipts, bounded in both count and bytes; never a game-state store. */
export class MutationMemo {
  private entries = new Map<string, { hash: string; response: TableApiResponse; bytes: number; expires: number }>();
  private bytes = 0;
  private hash(body: unknown) { return createHash('sha256').update(JSON.stringify(body)).digest('hex'); }
  lookup(id: string, body: unknown): { kind: 'miss' } | { kind: 'conflict' } | { kind: 'hit'; response: TableApiResponse } {
    this.prune();
    const hit = this.entries.get(id);
    if (!hit) return { kind: 'miss' };
    return hit.hash === this.hash(body) ? { kind: 'hit', response: hit.response } : { kind: 'conflict' };
  }
  remember(id: string, body: unknown, response: TableApiResponse) {
    const bytes = Buffer.byteLength(JSON.stringify(response));
    if (bytes > 8 * 1024 * 1024) return;
    this.entries.set(id, { hash: this.hash(body), response, bytes, expires: Date.now() + 10 * 60_000 });
    this.bytes += bytes;
    this.prune();
  }
  private prune() {
    for (const [id, entry] of this.entries) {
      if (entry.expires > Date.now() && this.entries.size <= 128 && this.bytes <= 8 * 1024 * 1024) break;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
    }
  }
}
