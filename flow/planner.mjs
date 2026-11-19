// 结算规划：把调度指令、资源商出口关系、计量读数与基线合并成
// 「可结算切片 + 待补采范围」。本模块不发起任何网络请求，便于单测。
//
// 关键口径：
// - 一切归属按物理出口（outlet）计算，站点编号只是资源商报数的别名；
//   同一出口同一计量片只认列一次，即便两个站点编号同时报数。
// - 从表（parent + independent=false）的量已含在主表内，不参与结算。
// - 表码只认区间差；表码复位必须凭独立的复位事件（resetAt）解释，
//   没有复位事件的回退记为数据问题，绝不填零穿过缺口。
// - 切片端点必须同时落在计量与基线提供的分界点上，量不按比例摊到
//   未提供分界点的区间。
// - 归属按调用优先级：同一时刻同一出口 priority 大者优先；高优先
//   调用撤回的时段，让给仍有效且满足条件的低优先调用。

import { fmtClock, fmtRange, parseClock } from './time.mjs';

const KWH_SCALE = 1e6;
export function roundKwh(value) {
  return Math.round(value * KWH_SCALE) / KWH_SCALE;
}

function parseRange([start, end]) {
  return [parseClock(start), parseClock(end)];
}

// ---------- 计量读数 → 区间量 ----------

// 把一只表的样本展开成带起止的区间量。
// quantity 条目本身就是区间量；counter 条目取相邻表码差。
// resetAt 是独立的表计事件：复位点之前的区间用 before 收口，
// 之后的区间从 after 起算。没有复位事件解释的回退不计量、不填零。
export function expandSample(sample) {
  const issues = [];
  const intervals = [];
  if (Array.isArray(sample.quantity)) {
    for (const [start, end, kwh] of sample.quantity) {
      const [s, e] = parseRange([start, end]);
      intervals.push({ start: s, end: e, kwh });
    }
  }
  if (Array.isArray(sample.counter)) {
    const resets = sample.resetAt
      ? (Array.isArray(sample.resetAt) ? sample.resetAt : [sample.resetAt])
      : [];
    const events = resets.map(reset => ({
      time: parseClock(reset.time), before: reset.before, after: reset.after,
    })).sort((a, b) => a.time - b.time);
    const points = sample.counter
      .map(([time, value]) => ({ time: parseClock(time), value }))
      .sort((a, b) => a.time - b.time);
    for (let index = 1; index < points.length; index += 1) {
      const prev = points[index - 1];
      const next = points[index];
      const inside = events.filter(event => prev.time < event.time && event.time <= next.time);
      if (inside.length === 0) {
        const kwh = next.value - prev.value;
        if (kwh < 0) {
          issues.push(`表码 ${fmtClock(prev.time)}→${fmtClock(next.time)} 由 ${prev.value} 回退到 ${next.value}，无复位事件，该段不计量`);
        } else {
          intervals.push({ start: prev.time, end: next.time, kwh });
        }
        continue;
      }
      // 复位事件提供分界点：逐段用 before/after 收口。
      let cursor = prev.time;
      let cursorValue = prev.value;
      for (const event of inside) {
        const head = event.before - cursorValue;
        if (head < 0) {
          issues.push(`复位事件 ${fmtClock(event.time)} 的 before=${event.before} 小于前值 ${cursorValue}，该段不计量`);
        } else {
          intervals.push({ start: cursor, end: event.time, kwh: head });
        }
        cursor = event.time;
        cursorValue = event.after;
      }
      if (cursor < next.time) {
        const tail = next.value - cursorValue;
        if (tail < 0) {
          issues.push(`复位后表码 ${fmtClock(cursor)}→${fmtClock(next.time)} 由 ${cursorValue} 回退到 ${next.value}，该段不计量`);
        } else {
          intervals.push({ start: cursor, end: next.time, kwh: tail });
        }
      }
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  return { intervals, issues };
}

// ---------- 区间集合小工具 ----------

function subtractRange(ranges, cuts) {
  let result = ranges.map(([s, e]) => [s, e]);
  for (const [cs, ce] of cuts) {
    const next = [];
    for (const [s, e] of result) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (s < cs) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    result = next;
  }
  return result;
}

// 相邻或重叠的区间并成最大覆盖段。
function mergeCoverage(intervals) {
  const merged = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
}

// 两组区间的覆盖交集（先各自并成覆盖段再相交）。
function coverageIntersection(first, second) {
  const a = mergeCoverage(first);
  const b = mergeCoverage(second);
  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) result.push([start, end]);
    if (a[i].end < b[j].end) i += 1;
    else j += 1;
  }
  return result;
}

function sumWithin(intervals, start, end) {
  return roundKwh(intervals
    .filter(interval => interval.start >= start && interval.end <= end)
    .reduce((total, interval) => total + interval.kwh, 0));
}

function boundariesOf(intervals) {
  const set = new Set();
  for (const interval of intervals) { set.add(interval.start); set.add(interval.end); }
  return set;
}

// ---------- 归属 ----------

// 每个出口上「归属恒定」的最大区间序列：priority 大者优先，
// 撤回段从调用中扣除后再比较。
export function attributeSegments(calls, outlet) {
  const edges = new Set();
  const active = calls.map(call => {
    const ranges = subtractRange([call.window], call.withdrawn);
    for (const [s, e] of ranges) { edges.add(s); edges.add(e); }
    return { id: call.id, priority: call.priority, ranges };
  });
  const segments = [];
  const sorted = [...edges].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index += 1) {
    const start = sorted[index - 1];
    const end = sorted[index];
    const contenders = active.filter(call =>
      call.ranges.some(([s, e]) => s <= start && e >= end));
    if (contenders.length === 0) continue;
    contenders.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const winner = contenders[0];
    const last = segments.at(-1);
    if (last && last.dispatch === winner.id && last.end === start) {
      last.end = end;
    } else {
      segments.push({ outlet, start, end, dispatch: winner.id, priority: winner.priority });
    }
  }
  return segments;
}

// 每个出口选主表：independent 行为主表；parent 且非 independent 的为从表，
// 从表的量已含在主表内。相同 outlet 是同一物理出口，站点编号只是别名。
function resolveMeters(outletRows, notes) {
  const byOutlet = new Map();
  for (const row of outletRows) {
    if (!byOutlet.has(row.outlet)) byOutlet.set(row.outlet, []);
    byOutlet.get(row.outlet).push(row);
  }
  const result = new Map();
  for (const [outlet, rows] of byOutlet) {
    const masters = rows.filter(row => row.independent);
    const slaves = rows.filter(row => !row.independent);
    const sites = rows.map(row => `${row.site}(${row.partner})`);
    if (sites.length > 1) {
      notes.push(`出口 ${outlet} 由 ${sites.join('、')} 共同报数，属同一物理出口，只按归属口径认列一次`);
    }
    for (const slave of slaves) {
      notes.push(`出口 ${outlet} 的 ${slave.meter}（${slave.site}）为从表，量已含于主表 ${slave.parent}，不重复计量`);
    }
    result.set(outlet, {
      rows,
      masters: masters.map(row => ({
        meter: row.meter, start: parseClock(row.valid[0]), end: parseClock(row.valid[1]),
      })),
    });
  }
  return result;
}

export const PENDING_REASONS = {
  'access-closed': '资源商未开放该时段领取',
  hold: '资源商暂缓领取',
  'metering-gap': '计量读数未覆盖',
  'baseline-gap': '基线未覆盖',
  'boundary-missing': '计量或基线未提供所需分界点，不可按比例分摊',
  'meter-invalid': '主表计量关系未覆盖该时段',
};

export function buildPlan({ windows, outlets, access, samples, baselines, target }) {
  const notes = [];
  const issues = [];

  // 1. 调度事件 → 目标区间与优先关系（值班先领这部分）。
  const calls = windows
    .filter(row => !target || target.length === 0 || target.includes(row.id))
    .map(row => ({
      id: row.id,
      priority: row.priority,
      window: parseRange(row.window),
      withdrawn: (row.withdrawn ?? []).map(parseRange),
      eligibleOutlets: row.eligibleOutlets ?? [],
    }));
  calls.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  // 2. 出口与主从计量关系。
  const meterMap = resolveMeters(outlets, notes);

  // 3. 计量样本：只取各出口主表的最新修订；从表读数不参与。
  const measuredByOutlet = new Map();
  for (const sample of samples) {
    const info = meterMap.get(sample.outlet);
    const master = info?.masters.find(entry => entry.meter === sample.meter);
    if (!master) {
      notes.push(`样本 ${sample.outlet}/${sample.meter} 非主表读数，已忽略（量含于主表）`);
      continue;
    }
    const expanded = expandSample(sample);
    for (const issue of expanded.issues) {
      issues.push(`出口 ${sample.outlet} 表 ${sample.meter}：${issue}`);
    }
    const existing = measuredByOutlet.get(sample.outlet);
    if (!existing || sample.revision > existing.revision) {
      measuredByOutlet.set(sample.outlet, {
        meter: sample.meter,
        revision: sample.revision,
        intervals: expanded.intervals,
        resets: (Array.isArray(sample.resetAt) ? sample.resetAt : [sample.resetAt])
          .filter(Boolean).map(reset => parseClock(reset.time)),
      });
    }
  }

  const baselineByOutlet = new Map();
  for (const entry of baselines) {
    const values = entry.values.map(([s, e, kwh]) => {
      const [start, end] = parseRange([s, e]);
      return { start, end, kwh };
    }).sort((a, b) => a.start - b.start);
    const existing = baselineByOutlet.get(entry.outlet);
    if (!existing || entry.revision > existing.revision) {
      baselineByOutlet.set(entry.outlet, { revision: entry.revision, values });
    }
  }

  const accessByOutlet = new Map();
  for (const row of access) {
    accessByOutlet.set(row.outlet, {
      open: [parseClock(row.openFrom), parseClock(row.openUntil)],
      holds: (row.hold ? [row.hold] : []).map(parseRange),
      retryAfterSeconds: row.retryAfterSeconds,
    });
  }

  // 4. 逐出口、逐归属段切片；某段的缺口不影响其余独立窗口。
  const slices = [];
  const pending = [];
  const outletIds = [...new Set([
    ...calls.flatMap(call => call.eligibleOutlets),
    ...meterMap.keys(),
  ])].sort();

  for (const outlet of outletIds) {
    const outletCalls = calls.filter(call => call.eligibleOutlets.includes(outlet));
    const segments = attributeSegments(outletCalls, outlet);
    const measured = measuredByOutlet.get(outlet);
    const baseline = baselineByOutlet.get(outlet);
    const accessRow = accessByOutlet.get(outlet);
    const info = meterMap.get(outlet);
    const measuredIntervals = measured?.intervals ?? [];
    const baselineValues = baseline?.values ?? [];
    const commonEdges = new Set(
      [...boundariesOf(measuredIntervals)].filter(edge => boundariesOf(baselineValues).has(edge)),
    );

    for (const segment of segments) {
      // 先按领取开放状态（开放/暂缓/未开放）与主表有效时段切段。
      const cuts = new Set([segment.start, segment.end]);
      if (accessRow) {
        for (const edge of accessRow.open) if (edge > segment.start && edge < segment.end) cuts.add(edge);
        for (const [hs, he] of accessRow.holds) {
          if (hs > segment.start && hs < segment.end) cuts.add(hs);
          if (he > segment.start && he < segment.end) cuts.add(he);
        }
      }
      for (const master of info?.masters ?? []) {
        if (master.start > segment.start && master.start < segment.end) cuts.add(master.start);
        if (master.end > segment.start && master.end < segment.end) cuts.add(master.end);
      }
      const grid = [...cuts].sort((a, b) => a - b);
      const runs = [];
      for (let index = 1; index < grid.length; index += 1) {
        const [start, end] = [grid[index - 1], grid[index]];
        let status = 'open';
        if (accessRow?.holds.some(([hs, he]) => hs <= start && he >= end)) status = 'hold';
        else if (!accessRow || start < accessRow.open[0] || end > accessRow.open[1]) status = 'closed';
        const metered = (info?.masters ?? []).some(master => master.start <= start && master.end >= end);
        const last = runs.at(-1);
        if (last && last.status === status && last.metered === metered && last.end === start) {
          last.end = end;
        } else {
          runs.push({ start, end, status, metered });
        }
      }
      for (const run of runs) {
        const pend = (reason, extra = {}) => pending.push({
          outlet, start: run.start, end: run.end, dispatch: segment.dispatch, reason, ...extra,
        });
        if (run.status === 'hold') {
          pend('hold', { retryAfterSeconds: accessRow.retryAfterSeconds });
          continue;
        }
        if (run.status === 'closed') { pend('access-closed'); continue; }
        if (!run.metered) { pend('meter-invalid'); continue; }

        // 开放时段：计量与基线覆盖的交集内，取端点同为两者分界点的最大切片。
        const covered = coverageIntersection(measuredIntervals, baselineValues)
          .map(([s, e]) => [Math.max(s, run.start), Math.min(e, run.end)])
          .filter(([s, e]) => s < e && s < run.end && e > run.start);
        let cursor = run.start;
        for (const [regionStart, regionEnd] of covered) {
          if (regionStart > cursor) {
            pushGap(pending, outlet, segment, cursor, regionStart, measuredIntervals);
          }
          // 区域内缩到同为计量与基线分界点的端点。
          const inner = [...commonEdges]
            .filter(edge => edge >= regionStart && edge <= regionEnd)
            .sort((a, b) => a - b);
          const head = inner.at(0);
          const tail = inner.at(-1);
          if (head === undefined || tail === undefined || head >= tail) {
            pending.push({
              outlet, start: regionStart, end: regionEnd, dispatch: segment.dispatch,
              reason: 'boundary-missing',
              detail: `区间 ${fmtRange(regionStart, regionEnd)} 内没有同为计量与基线分界点的端点`,
            });
          } else {
            if (head > regionStart) {
              pending.push({
                outlet, start: regionStart, end: head, dispatch: segment.dispatch,
                reason: 'boundary-missing',
                detail: `起点 ${fmtClock(regionStart)} 不是计量与基线共同的分界点`,
              });
            }
            if (tail < regionEnd) {
              pending.push({
                outlet, start: tail, end: regionEnd, dispatch: segment.dispatch,
                reason: 'boundary-missing',
                detail: `终点 ${fmtClock(regionEnd)} 不是计量与基线共同的分界点`,
              });
            }
            // 在每个共同分界点断开，得到最细的可对齐切片（只断不切量）。
            const splitPoints = inner.filter(edge => edge > head && edge < tail);
            let sliceStart = head;
            for (const point of [...splitPoints, tail]) {
              slices.push(makeSlice(outlet, segment, measured, baseline, sliceStart, point));
              sliceStart = point;
            }
          }
          cursor = regionEnd;
        }
        if (cursor < run.end) {
          pushGap(pending, outlet, segment, cursor, run.end, measuredIntervals);
        }
      }
    }
  }

  // 5. 合并相邻同因待补采段，便于调度员按段领数。
  pending.sort((a, b) => a.outlet.localeCompare(b.outlet) || a.start - b.start);
  const mergedPending = [];
  for (const item of pending) {
    const last = mergedPending.at(-1);
    if (last && last.outlet === item.outlet && last.reason === item.reason &&
        last.dispatch === item.dispatch && last.end === item.start &&
        last.retryAfterSeconds === item.retryAfterSeconds && !item.detail && !last.detail) {
      last.end = item.end;
    } else {
      mergedPending.push({ ...item });
    }
  }

  slices.sort((a, b) => a.outlet.localeCompare(b.outlet) || a.start - b.start);
  return { calls, slices, pending: mergedPending, notes, issues, meterMap };
}

function makeSlice(outlet, segment, measured, baseline, start, end) {
  const measuredKwh = sumWithin(measured?.intervals ?? [], start, end);
  const baselineKwh = sumWithin(baseline?.values ?? [], start, end);
  return {
    outlet, start, end,
    dispatch: segment.dispatch, priority: segment.priority,
    meter: measured?.meter ?? null,
    sampleRevision: measured?.revision ?? null,
    baselineRevision: baseline?.revision ?? null,
    measuredKwh, baselineKwh,
    netKwh: roundKwh(baselineKwh - measuredKwh),
    resetsInside: (measured?.resets ?? []).filter(time => time > start && time < end),
  };
}

// 覆盖缺口：计量未到的部分记 metering-gap，计量到而基线未到的记 baseline-gap。
function pushGap(pending, outlet, segment, start, end, measuredIntervals) {
  const gaps = subtractRange([[start, end]], measuredIntervals.map(i => [i.start, i.end]));
  let cursor = start;
  for (const [gs, ge] of gaps) {
    if (gs > cursor) {
      pending.push({ outlet, start: cursor, end: gs, dispatch: segment.dispatch, reason: 'baseline-gap' });
    }
    pending.push({ outlet, start: gs, end: ge, dispatch: segment.dispatch, reason: 'metering-gap' });
    cursor = ge;
  }
  if (cursor < end) {
    pending.push({ outlet, start: cursor, end, dispatch: segment.dispatch, reason: 'baseline-gap' });
  }
}

// ---------- 凭据与台账的对账 ----------

// 把新规划与台账里仍认可的凭据对照，产出待领的确认与冲正。
// 量或归属变了才冲正；修订号变而量不变（如扩了覆盖、加了复位事件）
// 不动账面，只在溯源里说明。
export function reconcile(plan, ledgerEntries) {
  const active = ledgerEntries.filter(entry =>
    entry.kind === 'confirmation' && entry.status === 'recognized');
  const confirmations = [];
  const reversals = [];
  const settled = [];
  const matched = new Set();

  for (const slice of plan.slices) {
    const match = active.find(entry =>
      entry.outlet === slice.outlet && entry.start === slice.start &&
      entry.end === slice.end && entry.dispatch === slice.dispatch);
    if (!match) {
      confirmations.push({ slice });
      continue;
    }
    matched.add(match);
    const revised = match.netKwh !== slice.netKwh ||
      match.measuredKwh !== slice.measuredKwh ||
      match.baselineKwh !== slice.baselineKwh;
    if (revised) {
      reversals.push({ entry: match, reason: '计量或基线修订，原认可量已不适用', slice });
      confirmations.push({ slice, supersedes: match });
    } else {
      settled.push({ slice, entry: match });
    }
  }

  for (const entry of active) {
    if (matched.has(entry) || reversals.some(reversal => reversal.entry === entry)) continue;
    const successor = plan.slices.find(slice =>
      slice.outlet === entry.outlet && slice.start === entry.start && slice.end === entry.end);
    const reason = successor
      ? `该段已改归 ${successor.dispatch}，原调用不再认列`
      : '该段已撤回或不再满足结算条件';
    reversals.push({ entry, reason, successor });
  }

  // 同一物理区间有未领的冲正时，新确认先挂起，避免两边同时认列。
  for (const confirmation of confirmations) {
    const blocking = reversals.find(reversal =>
      reversal.entry.outlet === confirmation.slice.outlet &&
      reversal.entry.start === confirmation.slice.start &&
      reversal.entry.end === confirmation.slice.end);
    if (blocking) confirmation.blockedBy = blocking;
  }
  return { confirmations, reversals, settled };
}

export function describePending(item) {
  const base = PENDING_REASONS[item.reason] ?? item.reason;
  if (item.reason === 'hold' && item.retryAfterSeconds != null) {
    return `${base}，约 ${item.retryAfterSeconds} 秒后可重试`;
  }
  return base;
}

export function explainSlice(slice, plan) {
  const others = plan.calls.filter(call =>
    call.id !== slice.dispatch && call.eligibleOutlets.includes(slice.outlet) &&
    call.window[0] < slice.end && call.window[1] > slice.start);
  const yielded = others.filter(call =>
    call.priority > slice.priority &&
    call.withdrawn.some(([s, e]) => s <= slice.start && e >= slice.end));
  const beaten = others.filter(call =>
    call.priority < slice.priority &&
    !call.withdrawn.some(([s, e]) => s <= slice.start && e >= slice.end));
  const parts = [`出口 ${slice.outlet} ${fmtRange(slice.start, slice.end)} 归属 ${slice.dispatch}（优先级 ${slice.priority}）`];
  if (yielded.length > 0) parts.push(`${yielded.map(call => call.id).join('、')} 已撤回该段，让与本次调用`);
  if (beaten.length > 0) parts.push(`同时段 ${beaten.map(call => call.id).join('、')} 优先级较低，不重复认列`);
  const resetNote = slice.resetsInside.length > 0
    ? `，含 ${slice.resetsInside.map(fmtClock).join('、')} 表码复位事件`
    : '';
  parts.push(`表 ${slice.meter} 修订${slice.sampleRevision} 实测 ${slice.measuredKwh} kWh${resetNote}`);
  parts.push(`基线修订${slice.baselineRevision} ${slice.baselineKwh} kWh，净认可 ${slice.netKwh} kWh`);
  return parts.join('；');
}
