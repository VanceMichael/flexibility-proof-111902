// 台账：记录已向财务来源领取的凭据，保证
// - 历史领取号及净认可量能追到调用、物理出口和采用的读数版本；
// - 同一物理区间不被两次同时认列（冲正先行）；
// - 经办号（requestKey）按内容确定生成，网络重试不会产生重复受理。

import { fmtRange } from './time.mjs';

export class Ledger {
  constructor(day) {
    this.day = day;
    this.entries = [];
    this.seq = 0;
  }

  // 经办号：FP<日>-<调用>-<出口>-<起>-<止>-<种类><序号>。
  // 同一物理区间同一种类的第 n 次提交序号递增；重试同一次提交时
  // 台账里还没有它，重新算出的仍是同一个号，来源侧按号去重。
  nextRequestKey(slice, kind) {
    const stamp = this.day.replaceAll('-', '');
    const base = `FP${stamp}-${slice.dispatch}-${slice.outlet}-` +
      `${String(slice.start).padStart(5, '0')}-${String(slice.end).padStart(5, '0')}`;
    const prefix = kind === 'reversal' ? 'R' : 'C';
    const taken = this.entries.filter(entry => entry.requestKey.startsWith(`${base}-${prefix}`)).length;
    return `${base}-${prefix}${taken + 1}`;
  }

  hasRequestKey(requestKey) {
    return this.entries.some(entry => entry.requestKey === requestKey);
  }

  addConfirmation({ slice, requestKey, receiptId, explain, phase, syncSeq }) {
    this.entries.push({
      kind: 'confirmation',
      requestKey,
      receiptId,
      dispatch: slice.dispatch,
      outlet: slice.outlet,
      start: slice.start,
      end: slice.end,
      netKwh: slice.netKwh,
      measuredKwh: slice.measuredKwh,
      baselineKwh: slice.baselineKwh,
      meter: slice.meter,
      sampleRevision: slice.sampleRevision,
      baselineRevision: slice.baselineRevision,
      status: 'recognized',
      explain,
      phase,
      syncSeq,
      claimedAt: new Date().toISOString(),
      verify: null,
    });
  }

  addReversal({ entry, requestKey, receiptId, reason, phase, syncSeq }) {
    const reversal = {
      kind: 'reversal',
      requestKey,
      receiptId,
      dispatch: entry.dispatch,
      outlet: entry.outlet,
      start: entry.start,
      end: entry.end,
      netKwh: -entry.netKwh,
      measuredKwh: entry.measuredKwh,
      baselineKwh: entry.baselineKwh,
      meter: entry.meter,
      sampleRevision: entry.sampleRevision,
      baselineRevision: entry.baselineRevision,
      priorReceipt: entry.receiptId,
      priorRequestKey: entry.requestKey,
      status: 'recognized',
      explain: `冲正 ${entry.receiptId}（${entry.dispatch} ${entry.outlet} ${fmtRange(entry.start, entry.end)}）：${reason}`,
      reason,
      phase,
      syncSeq,
      claimedAt: new Date().toISOString(),
      verify: null,
    };
    this.entries.push(reversal);
    entry.status = 'reversed';
    entry.reversedBy = receiptId;
    entry.reversalReason = reason;
    return reversal;
  }

  // 净认可量：按调用 × 出口汇总账面全部凭据。
  // 确认为正、冲正为负；被冲正的原凭据与其冲正互相抵销，
  // 因此两侧都计入，账面净额才是「不重复认列」的结果。
  netRecognized() {
    const totals = new Map();
    for (const entry of this.entries) {
      const key = `${entry.dispatch}|${entry.outlet}`;
      if (!totals.has(key)) {
        totals.set(key, { dispatch: entry.dispatch, outlet: entry.outlet, netKwh: 0, receipts: [] });
      }
      const row = totals.get(key);
      row.netKwh += entry.netKwh;
      row.receipts.push(entry.receiptId);
    }
    for (const row of totals.values()) {
      row.netKwh = Math.round(row.netKwh * 1e6) / 1e6;
    }
    return [...totals.values()].sort((a, b) =>
      a.dispatch.localeCompare(b.dispatch) || a.outlet.localeCompare(b.outlet));
  }
}
