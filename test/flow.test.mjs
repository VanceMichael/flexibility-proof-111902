import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createSource } from '../source.mjs';
import { createFlow } from '../flow/server.mjs';

const request = {
  dispatchDay: '2026-11-19',
  target: ['Q-8', 'Q-10'],
  timezone: 'Asia/Shanghai',
};

const source = createSource().listen(0, '127.0.0.1');
await once(source, 'listening');
const sourceOrigin = `http://127.0.0.1:${source.address().port}`;

const flow = createFlow({ sourceOrigin, request });
const app = flow.server.listen(0, '127.0.0.1');
await once(app, 'listening');
const origin = `http://127.0.0.1:${app.address().port}`;

test.after(async () => {
  app.close();
  source.close();
  await Promise.all([once(app, 'close'), once(source, 'close')]);
});

const post = (path, body) => fetch(origin + path, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body ?? {}),
  redirect: 'manual',
});
const state = () => fetch(origin + '/flow/api/state').then(res => res.json());
const setPhase = phase => fetch(sourceOrigin + '/replay/phase', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase }),
});

test('凭据全流程：同步、领取、撤回冲正、改认与溯源核对', async () => {
  // 值班同步：领到目标区间与优先关系，财务待领 4 笔确认
  await setPhase(0);
  let response = await post('/flow/sync');
  assert.equal(response.status, 303);
  let snapshot = await state();
  assert.equal(snapshot.sourcePhase, 0);
  assert.equal(snapshot.candidates.confirmations.length, 4);
  assert.equal(snapshot.candidates.reversals.length, 0);
  assert.equal(snapshot.plan.pending.length, 3); // M54 两段未开放 + M76 一段暂缓

  // 待补采范围说明缺的是哪段、为何暂缓
  const hold = snapshot.plan.pending.find(item => item.reason === 'hold');
  assert.equal(hold.outlet, 'M76');
  assert.equal(hold.retryAfterSeconds, 15);

  // 财务领走全部确认
  response = await post('/flow/claim-all');
  assert.equal(response.status, 303);
  snapshot = await state();
  assert.equal(snapshot.ledger.length, 4);
  assert.equal(snapshot.candidates.confirmations.length, 0);

  // 凭据在来源侧可按经办号核对，窗口带调度日与时区
  const first = snapshot.ledger[0];
  const verified = await fetch(
    `${sourceOrigin}/finance/receipts?requestKey=${encodeURIComponent(first.requestKey)}`);
  const view = await verified.json();
  assert.equal(view.state, '已受理');
  assert.deepEqual(view.submitted.window, ['2026-11-19T15:00:00+08:00', '2026-11-19T15:30:00+08:00']);
  assert.equal(view.submitted.dispatch, 'Q-8');

  // 演练进入阶段 1：Q-8 撤回 15:40–15:50，计量补录到位、暂缓解除
  await setPhase(1);
  await post('/flow/sync');
  snapshot = await state();
  assert.equal(snapshot.sourcePhase, 1);
  assert.equal(snapshot.plan.pending.length, 0);
  assert.equal(snapshot.candidates.reversals.length, 1);
  assert.equal(snapshot.candidates.confirmations.length, 4);

  // 改认 Q-10 的确认被冲正挂起，不能抢领（不能两边同时认列）
  const blocked = snapshot.candidates.confirmations.find(item => item.blockedBy);
  assert.equal(blocked.slice.dispatch, 'Q-10');
  response = await post('/flow/claim', { key: blocked.requestKey });
  assert.equal(response.status, 409);

  // 先冲正后确认：一次全部领走
  response = await post('/flow/claim-all');
  assert.equal(response.status, 303);
  snapshot = await state();
  assert.equal(snapshot.candidates.reversals.length, 0);
  assert.equal(snapshot.candidates.confirmations.length, 0);

  // 台账：冲正引用原领取号，原凭据状态改为已冲正
  const reversal = snapshot.ledger.find(entry => entry.kind === 'reversal');
  assert.equal(reversal.netKwh, -5);
  const reversed = snapshot.ledger.find(entry => entry.receiptId === reversal.priorReceipt);
  assert.equal(reversed.status, 'reversed');
  assert.equal(reversed.reversedBy, reversal.receiptId);

  // 净认可量按调用 × 物理出口可追溯
  const totals = Object.fromEntries(snapshot.netRecognized.map(row =>
    [`${row.dispatch}|${row.outlet}`, row.netKwh]));
  assert.deepEqual(totals, {
    'Q-10|M54': 10, // 15:40–15:50 让与 5 + 16:00–16:15 5
    'Q-10|M76': 6,  // 15:30–16:00 4 + 16:00–16:15 2
    'Q-8|M54': 14,  // 6 + 4 + 5 − 5（冲正）+ 4
  });

  // 冲正凭据在来源侧同样可查，且带着 priorReceipt
  const reversalView = await (await fetch(
    `${sourceOrigin}/finance/receipts?requestKey=${encodeURIComponent(reversal.requestKey)}`)).json();
  assert.equal(reversalView.submitted.priorReceipt, reversed.receiptId);
  assert.equal(reversalView.submitted.netKwh, -5);

  // 历史领取号追到调用、出口与采用的读数版本
  assert.equal(reversed.sampleRevision, 1); // 旧凭据基于修订 1，当时归属 Q-8 有效
  const handed = snapshot.ledger.find(entry =>
    entry.kind === 'confirmation' && entry.dispatch === 'Q-10' && entry.outlet === 'M54' &&
    entry.start === 15 * 3600 + 40 * 60);
  assert.equal(handed.sampleRevision, 2); // 改认后采用含复位事件的修订 2

  // 重复同步不产生新的待领，账面稳定
  await post('/flow/sync');
  snapshot = await state();
  assert.equal(snapshot.candidates.reversals.length, 0);
  assert.equal(snapshot.candidates.confirmations.length, 0);
  assert.equal(snapshot.ledger.length, 9);
});
