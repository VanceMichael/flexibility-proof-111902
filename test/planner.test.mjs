import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { attributeSegments, buildPlan, expandSample, reconcile } from '../flow/planner.mjs';
import { parseClock } from '../flow/time.mjs';

const scenario = JSON.parse(await readFile(new URL('../scenario.json', import.meta.url), 'utf8'));

function inputsAt(phase) {
  const pick = path => scenario.routes.find(route => route.path === path).steps[phase];
  return {
    windows: pick('/dispatch/windows'),
    outlets: pick('/partners/outlets'),
    access: pick('/partners/access'),
    samples: pick('/partners/samples'),
    baselines: pick('/dispatch/baselines'),
    target: ['Q-8', 'Q-10'],
  };
}

const t = clock => parseClock(clock);

test('表码复位凭独立复位事件解释，不填零穿过缺口', () => {
  const { intervals, issues } = expandSample({
    outlet: 'M54', meter: 'U5', revision: 2,
    counter: [['15:00', 100], ['15:30', 114], ['15:40', 118], ['15:45', 3], ['15:50', 5], ['16:00', 9], ['16:15', 14]],
    resetAt: { time: '15:45', before: 120, after: 3 },
  });
  assert.deepEqual(issues, []);
  const byStart = Object.fromEntries(intervals.map(i => [i.start, i]));
  assert.equal(byStart[t('15:40')].kwh, 2); // 120 - 118，复位前收口
  assert.equal(byStart[t('15:45')].kwh, 2); // 5 - 3，复位后起算
  assert.equal(byStart[t('16:00')].kwh, 5);
  // 复位前后总量与未复位口径一致（15:40→15:50 共 4 kWh）
  const total = intervals.filter(i => i.start >= t('15:40') && i.end <= t('15:50'))
    .reduce((sum, i) => sum + i.kwh, 0);
  assert.equal(total, 4);
});

test('表码回退且无复位事件：该段不计量也不填零', () => {
  const { intervals, issues } = expandSample({
    outlet: 'M54', meter: 'U5', revision: 3,
    counter: [['15:00', 100], ['15:30', 40]],
  });
  assert.equal(intervals.length, 0);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /无复位事件/);
});

test('阶段 0：切片按归属与共同分界点产出，量不按比例分摊', () => {
  const plan = buildPlan(inputsAt(0));
  const key = slice => `${slice.dispatch}|${slice.outlet}|${fmt(slice.start)}|${fmt(slice.end)}`;
  const slices = Object.fromEntries(plan.slices.map(slice => [key(slice), slice]));

  assert.equal(plan.slices.length, 4);
  assert.equal(slices['Q-8|M54|15:00:00|15:30:00'].netKwh, 6); // 基线20 − 实测14
  assert.equal(slices['Q-8|M54|15:30:00|15:40:00'].netKwh, 4);
  assert.equal(slices['Q-8|M54|15:40:00|15:50:00'].netKwh, 5);
  assert.equal(slices['Q-10|M76|15:30:00|16:00:00'].netKwh, 4); // 基线17 − 实测13

  // 待补采：M54 15:50 后未开放；M76 16:00–16:15 暂缓且带重试秒数
  const pending = plan.pending.map(item => ({ ...item, span: fmt(item.start) + '|' + fmt(item.end) }));
  const m54Closed = pending.filter(item => item.outlet === 'M54' && item.reason === 'access-closed');
  assert.deepEqual(m54Closed.map(item => item.span), ['15:50:00|16:00:00', '16:00:00|16:15:00']);
  assert.deepEqual(m54Closed.map(item => item.dispatch), ['Q-8', 'Q-10']);
  const m76Hold = pending.find(item => item.outlet === 'M76');
  assert.equal(m76Hold.reason, 'hold');
  assert.equal(m76Hold.retryAfterSeconds, 15);
  assert.equal(m76Hold.span, '16:00:00|16:15:00');

  // 站群跨代理商、同一物理出口只认列一次；从表不重复计量
  assert.ok(plan.notes.some(note => note.includes('ST18') && note.includes('R22') && note.includes('认列一次')));
  assert.ok(plan.notes.some(note => note.includes('Y3') && note.includes('从表')));
});

test('阶段 1：高优先撤回段让与低优先，复位只影响对应段', () => {
  const plan = buildPlan(inputsAt(1));
  const slices = Object.fromEntries(plan.slices.map(slice =>
    [`${slice.dispatch}|${slice.outlet}|${fmt(slice.start)}|${fmt(slice.end)}`, slice]));

  // Q-8 撤回 15:40–15:50，该段改归 Q-10；基线 9 不在 15:45 拆分
  const handed = slices['Q-10|M54|15:40:00|15:50:00'];
  assert.equal(handed.measuredKwh, 4); // 复位事件 2 + 2
  assert.equal(handed.baselineKwh, 9);
  assert.equal(handed.netKwh, 5);
  assert.equal(handed.sampleRevision, 2);

  assert.equal(slices['Q-8|M54|15:50:00|16:00:00'].netKwh, 4); // 基线8 − 实测4
  assert.equal(slices['Q-10|M54|16:00:00|16:15:00'].netKwh, 5);
  assert.equal(slices['Q-10|M76|16:00:00|16:15:00'].netKwh, 2);
  assert.equal(plan.pending.length, 0); // 阶段 1 全部开放且覆盖完整
});

test('对账：撤回段先冲正再改认，其余独立窗口不受影响', () => {
  const plan0 = buildPlan(inputsAt(0));
  const ledgerEntries = [];
  // 模拟财务已领走阶段 0 的全部确认
  for (const slice of plan0.slices) {
    ledgerEntries.push({
      kind: 'confirmation', status: 'recognized',
      outlet: slice.outlet, start: slice.start, end: slice.end, dispatch: slice.dispatch,
      netKwh: slice.netKwh, measuredKwh: slice.measuredKwh, baselineKwh: slice.baselineKwh,
      sampleRevision: slice.sampleRevision, baselineRevision: slice.baselineRevision,
      receiptId: `R-test-${slice.dispatch}-${slice.start}`,
    });
  }

  const plan1 = buildPlan(inputsAt(1));
  const { confirmations, reversals, settled } = reconcile(plan1, ledgerEntries);

  // 只有 Q-8 的 15:40–15:50 需要冲正
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].entry.dispatch, 'Q-8');
  assert.deepEqual([reversals[0].entry.start, reversals[0].entry.end], [t('15:40'), t('15:50')]);
  assert.match(reversals[0].reason, /改归 Q-10/);

  // 新确认 4 笔；改认 Q-10 的那笔被冲正挂起，其余立即可领
  assert.equal(confirmations.length, 4);
  const blocked = confirmations.filter(item => item.blockedBy);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].slice.dispatch, 'Q-10');
  assert.deepEqual([blocked[0].slice.start, blocked[0].slice.end], [t('15:40'), t('15:50')]);

  // 量未变的已领切片（含 M76 独立窗口）保持认可，不被误冲正
  assert.equal(settled.length, 3);
  assert.ok(settled.some(item => item.slice.outlet === 'M76'));
});

test('量修订而归属不变：冲正旧量并按新量确认', () => {
  const plan0 = buildPlan(inputsAt(0));
  const claimed = plan0.slices.map(slice => ({
    kind: 'confirmation', status: 'recognized',
    outlet: slice.outlet, start: slice.start, end: slice.end, dispatch: slice.dispatch,
    netKwh: slice.netKwh, measuredKwh: slice.measuredKwh, baselineKwh: slice.baselineKwh,
    sampleRevision: slice.sampleRevision, baselineRevision: slice.baselineRevision,
    receiptId: 'R-x',
  }));
  // 同一份规划但某切片基线被修订
  const revisedPlan = buildPlan(inputsAt(0));
  revisedPlan.slices[0] = { ...revisedPlan.slices[0], baselineKwh: 25, netKwh: 11 };
  const { reversals, confirmations } = reconcile(revisedPlan, claimed);
  assert.equal(reversals.length, 1);
  assert.match(reversals[0].reason, /修订/);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].slice.netKwh, 11);
  assert.ok(confirmations[0].blockedBy);
});

test('归属优先级：撤回只撤指定时段，其余时段仍归高优先', () => {
  const calls = [
    { id: 'Q-8', priority: 30, window: [t('15:00'), t('16:00')], withdrawn: [[t('15:40'), t('15:50')]] },
    { id: 'Q-10', priority: 15, window: [t('15:30'), t('16:15')], withdrawn: [] },
  ];
  const segments = attributeSegments(calls, 'M54');
  assert.deepEqual(segments.map(s => [s.dispatch, fmt(s.start), fmt(s.end)]), [
    ['Q-8', '15:00:00', '15:40:00'],
    ['Q-10', '15:40:00', '15:50:00'],
    ['Q-8', '15:50:00', '16:00:00'],
    ['Q-10', '16:00:00', '16:15:00'],
  ]);
});

function fmt(seconds) {
  const pad = value => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds % 3600 / 60))}:${pad(seconds % 60)}`;
}
