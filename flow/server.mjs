// 凭据流程服务：把资源商接口、调度指令和计量补录接到凭据流程。
// - 调度员视图：目标区间与调用优先关系、出口计量关系、可结算切片、待补采范围。
// - 财务视图：待领的确认/冲正凭据（带根据）、已领台账、净认可量汇总与溯源核对。
//
// 直接运行：node flow/server.mjs（环境变量 SOURCE_ORIGIN、PORT、REQUEST_FILE）。

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fetchInputs, fetchReceipt, postReceipt } from './source-client.mjs';
import { Ledger } from './ledger.mjs';
import { buildPlan, describePending, explainSlice, reconcile } from './planner.mjs';
import { fmtRange, localToIso } from './time.mjs';

function htmlEscape(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(value).replace(/[&<>"]/g, character => entities[character]);
}

function page(title, body) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + htmlEscape(title) + '</title><style>' +
    'body{font:16px system-ui,sans-serif;margin:0;background:#f7f8f8;color:#182625}' +
    'main{max-width:1180px;margin:auto;padding:24px}nav{display:flex;flex-wrap:wrap;gap:16px;padding:16px 24px;background:#123b36}' +
    'nav a{color:#fff}h1{font-size:24px}h2{font-size:18px;margin-top:28px}.table{overflow:auto}' +
    'table{border-collapse:collapse;width:100%;background:white}td,th{border-bottom:1px solid #d6e0df;padding:9px 12px;text-align:left;vertical-align:top}' +
    'th{background:#e4efed}form.inline{display:inline}button{background:#126354;color:white;border:0;border-radius:4px;font:inherit;padding:7px 12px;cursor:pointer}' +
    'button[disabled]{background:#9db3af;cursor:not-allowed}.bar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-block:14px}' +
    '.note{background:#fff8e8;border:1px solid #e3c97c;padding:10px 14px;border-radius:6px;margin-block:10px}' +
    '.ok{background:#e9f6ef;border:1px solid #8fc7a9}.bad{background:#fbecec;border-color:#dfa0a0}' +
    'details{background:white;border:1px solid #d6e0df;border-radius:6px;padding:10px 14px;margin-block:8px}' +
    'summary{cursor:pointer;font-weight:600}.rev{color:#8c2f2f;font-weight:600}.mut{color:#5c6f6c;font-size:14px}' +
    'a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #b47510;outline-offset:3px}' +
    '</style><nav aria-label="凭据流程"><a href="/dispatch">调度员视图</a><a href="/finance">财务视图</a>' +
    '<a href="/flow/api/state">状态 JSON</a></nav><main><h1>' + htmlEscape(title) + '</h1>' + body + '</main></html>';
}

function table(headings, rows) {
  if (rows.length === 0) return '<p class="mut">暂无。</p>';
  return '<div class="table"><table><thead><tr>' +
    headings.map(heading => '<th scope="col">' + htmlEscape(heading) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row =>
      '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function form(action, fields, label, extra = {}) {
  const inputs = Object.entries(fields).map(([name, value]) =>
    '<input type="hidden" name="' + htmlEscape(name) + '" value="' + htmlEscape(value) + '">').join('');
  const disabled = extra.disabled ? ' disabled' : '';
  const title = extra.title ? ' title="' + htmlEscape(extra.title) + '"' : '';
  return '<form class="inline" method="POST" action="' + htmlEscape(action) + '">' + inputs +
    '<button type="submit"' + disabled + title + '>' + htmlEscape(label) + '</button></form>';
}

export function createFlow({ sourceOrigin, request }) {
  const ledger = new Ledger(request.dispatchDay);
  const state = {
    syncSeq: 0,
    syncedAt: null,
    sourcePhase: null,
    plan: null,
    inputs: null,
    candidates: { confirmations: [], reversals: [], settled: [] },
    lastError: null,
  };

  function sliceWindow(slice) {
    return [
      localToIso(request.dispatchDay, slice.start, request.timezone),
      localToIso(request.dispatchDay, slice.end, request.timezone),
    ];
  }

  function rebuildCandidates() {
    if (!state.plan) return;
    const { confirmations, reversals, settled } = reconcile(state.plan, ledger.entries);
    for (const reversal of reversals) {
      reversal.requestKey = ledger.nextRequestKey(reversal.entry, 'reversal');
      reversal.explain = `冲正 ${reversal.entry.receiptId}（${reversal.entry.dispatch} ` +
        `${reversal.entry.outlet} ${fmtRange(reversal.entry.start, reversal.entry.end)}，` +
        `原认可 ${reversal.entry.netKwh} kWh，采用样本修订${reversal.entry.sampleRevision}、` +
        `基线修订${reversal.entry.baselineRevision}）：${reversal.reason}`;
    }
    for (const confirmation of confirmations) {
      confirmation.requestKey = ledger.nextRequestKey(confirmation.slice, 'confirmation');
      confirmation.explain = explainSlice(confirmation.slice, state.plan);
    }
    state.candidates = { confirmations, reversals, settled };
  }

  async function sync() {
    const inputs = await fetchInputs(sourceOrigin);
    state.inputs = inputs;
    state.sourcePhase = inputs.phase;
    state.plan = buildPlan({ ...inputs, target: request.target });
    state.syncSeq += 1;
    state.syncedAt = new Date().toISOString();
    state.lastError = null;
    rebuildCandidates();
  }

  async function claimReversal(reversal) {
    const payload = {
      requestKey: reversal.requestKey,
      window: sliceWindow(reversal.entry),
      dispatch: reversal.entry.dispatch,
      netKwh: -reversal.entry.netKwh,
      priorReceipt: reversal.entry.receiptId,
    };
    const result = await postReceipt(sourceOrigin, payload);
    if (!result.ok && result.status !== 200) {
      throw new Error(`冲正 ${reversal.requestKey} 未受理：${JSON.stringify(result.body)}`);
    }
    ledger.addReversal({
      entry: reversal.entry,
      requestKey: reversal.requestKey,
      receiptId: result.body.receipt,
      reason: reversal.reason,
      phase: state.sourcePhase,
      syncSeq: state.syncSeq,
    });
    return result.body.receipt;
  }

  async function claimConfirmation(confirmation) {
    if (confirmation.blockedBy) {
      throw new Error(`切片 ${confirmation.requestKey} 待冲正 ${confirmation.blockedBy.entry.receiptId} 后才能认列`);
    }
    const payload = {
      requestKey: confirmation.requestKey,
      window: sliceWindow(confirmation.slice),
      dispatch: confirmation.slice.dispatch,
      netKwh: confirmation.slice.netKwh,
    };
    const result = await postReceipt(sourceOrigin, payload);
    if (!result.ok && result.status !== 200) {
      throw new Error(`确认 ${confirmation.requestKey} 未受理：${JSON.stringify(result.body)}`);
    }
    ledger.addConfirmation({
      slice: confirmation.slice,
      requestKey: confirmation.requestKey,
      receiptId: result.body.receipt,
      explain: confirmation.explain,
      phase: state.sourcePhase,
      syncSeq: state.syncSeq,
    });
    return result.body.receipt;
  }

  // 领取顺序：先冲正后确认，同一物理区间不会两边同时认列。
  async function claimAll() {
    const claimed = [];
    for (const reversal of [...state.candidates.reversals]) {
      claimed.push(await claimReversal(reversal));
      rebuildCandidates();
    }
    for (const confirmation of [...state.candidates.confirmations]) {
      if (confirmation.blockedBy) continue;
      claimed.push(await claimConfirmation(confirmation));
      rebuildCandidates();
    }
    return claimed;
  }

  function findCandidate(requestKey) {
    const reversal = state.candidates.reversals.find(item => item.requestKey === requestKey);
    if (reversal) return { kind: 'reversal', candidate: reversal };
    const confirmation = state.candidates.confirmations.find(item => item.requestKey === requestKey);
    if (confirmation) return { kind: 'confirmation', candidate: confirmation };
    return null;
  }

  // ---------- 页面 ----------

  function statusBar() {
    const parts = [
      `调度日 ${request.dispatchDay}（${request.timezone}）`,
      `目标调用 ${request.target.join('、')}`,
      `来源 ${sourceOrigin}`,
    ];
    if (state.syncedAt) {
      parts.push(`来源阶段 ${state.sourcePhase}`, `第 ${state.syncSeq} 次同步 ${state.syncedAt}`);
    } else {
      parts.push('尚未同步');
    }
    const syncButton = '<form class="inline" method="POST" action="/flow/sync">' +
      '<button type="submit">同步来源 / 重新归集</button></form>';
    const error = state.lastError ? `<div class="note bad">同步失败：${htmlEscape(state.lastError)}</div>` : '';
    return `<div class="bar"><span>${parts.map(htmlEscape).join(' ｜ ')}</span>${syncButton}</div>${error}`;
  }

  function dispatchPage() {
    if (!state.plan) return page('调度员视图', statusBar() + '<p>尚未同步来源资料。</p>');
    const { plan } = state;

    const callRows = plan.calls.map(call => [
      htmlEscape(call.id),
      String(call.priority),
      htmlEscape(fmtRange(...call.window)),
      call.withdrawn.length
        ? htmlEscape(call.withdrawn.map(range => fmtRange(...range)).join('、'))
        : '<span class="mut">无</span>',
      htmlEscape(call.eligibleOutlets.join('、')),
    ]);

    const meterRows = [];
    for (const [outlet, info] of plan.meterMap) {
      for (const row of info.rows) {
        meterRows.push([
          htmlEscape(outlet),
          htmlEscape(`${row.site}（${row.partner}）`),
          htmlEscape(row.meter),
          row.independent ? '主表' : `从表（量含于 ${htmlEscape(row.parent)}）`,
          htmlEscape(`${row.valid[0]}–${row.valid[1]}`),
        ]);
      }
    }

    const claimedByKey = new Map();
    for (const entry of ledger.entries) {
      claimedByKey.set(`${entry.outlet}|${entry.start}|${entry.end}|${entry.dispatch}`, entry);
    }
    const sliceRows = plan.slices.map(slice => {
      const entry = claimedByKey.get(`${slice.outlet}|${slice.start}|${slice.end}|${slice.dispatch}`);
      const status = entry
        ? (entry.status === 'recognized'
          ? `已领 ${htmlEscape(entry.receiptId)}`
          : `已冲正（${htmlEscape(entry.receiptId)} → ${htmlEscape(entry.reversedBy ?? '')}）`)
        : '待财务领取';
      return [
        htmlEscape(slice.outlet),
        htmlEscape(fmtRange(slice.start, slice.end)),
        htmlEscape(`${slice.dispatch}（优先级 ${slice.priority}）`),
        `${slice.measuredKwh}（表 ${htmlEscape(slice.meter)} 修订${slice.sampleRevision}）`,
        `${slice.baselineKwh}（修订${slice.baselineRevision}）`,
        String(slice.netKwh),
        status,
      ];
    });

    const pendingByOutlet = new Map();
    for (const item of plan.pending) {
      if (!pendingByOutlet.has(item.outlet)) pendingByOutlet.set(item.outlet, []);
      pendingByOutlet.get(item.outlet).push(item);
    }
    const pendingBlocks = [...pendingByOutlet.entries()].map(([outlet, items]) => {
      const rows = items.map(item => [
        htmlEscape(fmtRange(item.start, item.end)),
        htmlEscape(item.dispatch ?? '—'),
        htmlEscape(describePending(item)),
        htmlEscape(item.detail ?? ''),
      ]);
      return `<details><summary>出口 ${htmlEscape(outlet)}：${items.length} 段待补采 / 待开放</summary>` +
        table(['时段', '受影响调用', '原因', '说明'], rows) + '</details>';
    }).join('');

    const notes = [...plan.notes, ...plan.issues].map(note =>
      `<div class="note">${htmlEscape(note)}</div>`).join('');

    return page('调度员视图', statusBar() +
      '<h2>目标区间与调用优先关系</h2>' +
      table(['调用', '优先级', '窗口', '撤回段', '可结算出口'], callRows) +
      '<h2>出口与计量关系</h2>' +
      table(['物理出口', '站点（资源商）', '表计', '主从关系', '有效时段'], meterRows) +
      notes +
      '<h2>可结算切片（基线 − 实测，按同一出口与切片出凭据）</h2>' +
      table(['出口', '时段', '归属调用', '实测 kWh', '基线 kWh', '净认可 kWh', '状态'], sliceRows) +
      '<h2>待补采范围</h2>' +
      (pendingBlocks || '<p class="mut">当前没有待补采或待开放的时段。</p>'));
  }

  function financePage(note) {
    const { confirmations, reversals, settled } = state.candidates;

    const reversalRows = reversals.map(reversal => [
      '<span class="rev">冲正</span>',
      htmlEscape(reversal.requestKey),
      htmlEscape(reversal.entry.dispatch),
      htmlEscape(reversal.entry.outlet),
      htmlEscape(fmtRange(reversal.entry.start, reversal.entry.end)),
      String(-reversal.entry.netKwh),
      htmlEscape(reversal.explain),
      form('/flow/claim', { key: reversal.requestKey }, '领取冲正'),
    ]);
    const confirmationRows = confirmations.map(confirmation => [
      '确认',
      htmlEscape(confirmation.requestKey),
      htmlEscape(confirmation.slice.dispatch),
      htmlEscape(confirmation.slice.outlet),
      htmlEscape(fmtRange(confirmation.slice.start, confirmation.slice.end)),
      String(confirmation.slice.netKwh),
      htmlEscape(confirmation.explain),
      confirmation.blockedBy
        ? form('/flow/claim', { key: confirmation.requestKey }, '待冲正解锁', {
          disabled: true,
          title: `需先领取对 ${confirmation.blockedBy.entry.receiptId} 的冲正`,
        }) + `<div class="mut">待冲正 ${htmlEscape(confirmation.blockedBy.entry.receiptId)}</div>`
        : form('/flow/claim', { key: confirmation.requestKey }, '领取确认'),
    ]);
    const claimable = reversals.length + confirmations.filter(item => !item.blockedBy).length;
    const claimAllButton = claimable > 0
      ? '<form class="inline" method="POST" action="/flow/claim-all"><button type="submit">全部领取（先冲正后确认）</button></form>'
      : '';

    const ledgerRows = ledger.entries.map(entry => [
      htmlEscape(entry.receiptId),
      htmlEscape(entry.requestKey),
      entry.kind === 'reversal' ? '<span class="rev">冲正</span>' : '确认',
      htmlEscape(entry.dispatch),
      htmlEscape(entry.outlet),
      htmlEscape(fmtRange(entry.start, entry.end)),
      String(entry.netKwh),
      `样本修订${entry.sampleRevision} ／ 基线修订${entry.baselineRevision}`,
      entry.status === 'recognized' ? '认可中' : `已冲正 → ${htmlEscape(entry.reversedBy ?? '')}`,
      entry.verify ? htmlEscape(entry.verify) : '<span class="mut">未核对</span>',
      form('/flow/verify', { key: entry.requestKey }, '核对'),
    ]);

    const totals = ledger.netRecognized();
    const totalRows = totals.map(row => [
      htmlEscape(row.dispatch),
      htmlEscape(row.outlet),
      String(row.netKwh),
      htmlEscape(row.receipts.join('、')),
    ]);

    const explainBlocks = ledger.entries
      .filter(entry => entry.kind === 'reversal' || entry.status === 'reversed')
      .map(entry => {
        const text = entry.kind === 'reversal'
          ? `${entry.receiptId}：${entry.explain}`
          : `${entry.receiptId} 曾可用：${entry.explain}；后因「${entry.reversalReason}」被 ${entry.reversedBy} 冲正。`;
        return `<div class="note">${htmlEscape(text)}</div>`;
      }).join('');

    return page('财务视图', statusBar() +
      (note ? `<div class="note ok">${htmlEscape(note)}</div>` : '') +
      '<h2>待领凭据（有根据的确认与冲正）</h2>' +
      `<div class="bar">${claimAllButton}<span class="mut">已同步切片中 ${settled.length} 段与账面一致，无需重复领取。</span></div>` +
      table(['类型', '经办号', '调用', '出口', '时段', '净认可 kWh', '根据', '操作'],
        [...reversalRows, ...confirmationRows]) +
      '<h2>已领凭据台账</h2>' +
      table(['领取号', '经办号', '类型', '调用', '出口', '时段', '净 kWh', '采用读数版本', '状态', '来源核对', '操作'], ledgerRows) +
      '<h2>净认可量汇总（按调用 × 物理出口）</h2>' +
      table(['调用', '出口', '净认可 kWh', '构成领取号'], totalRows) +
      '<h2>冲正与溯源说明</h2>' +
      (explainBlocks || '<p class="mut">暂无冲正。</p>'));
  }

  // ---------- 路由 ----------

  async function readBody(request) {
    let input = '';
    for await (const chunk of request) input += chunk;
    return Object.fromEntries(new URLSearchParams(input));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'text/html') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(body);
    };
    const redirect = location => {
      res.writeHead(303, { location });
      res.end();
    };
    try {
      if (req.method === 'GET' && url.pathname === '/') return redirect('/dispatch');
      if (req.method === 'GET' && url.pathname === '/dispatch') return send(200, dispatchPage());
      if (req.method === 'GET' && url.pathname === '/finance') {
        return send(200, financePage(url.searchParams.get('note')));
      }
      if (req.method === 'GET' && url.pathname === '/flow/api/state') {
        return send(200, JSON.stringify({
          request, sourcePhase: state.sourcePhase, syncSeq: state.syncSeq, syncedAt: state.syncedAt,
          plan: state.plan ? {
            slices: state.plan.slices, pending: state.plan.pending,
            notes: state.plan.notes, issues: state.plan.issues,
          } : null,
          candidates: state.candidates,
          ledger: ledger.entries,
          netRecognized: ledger.netRecognized(),
        }, null, 2), 'application/json');
      }
      if (req.method === 'POST' && url.pathname === '/flow/sync') {
        try {
          await sync();
        } catch (error) {
          state.lastError = error.message;
        }
        return redirect(req.headers.referer?.includes('/finance') ? '/finance' : '/dispatch');
      }
      if (req.method === 'POST' && url.pathname === '/flow/claim') {
        const { key } = await readBody(req);
        const found = findCandidate(key);
        if (!found) return send(409, page('无法领取', `<div class="note bad">经办号 ${htmlEscape(key)} 不在待领列表，请先同步。</div>`));
        try {
          if (found.kind === 'reversal') await claimReversal(found.candidate);
          else await claimConfirmation(found.candidate);
        } catch (error) {
          return send(409, page('未受理', `<div class="note bad">${htmlEscape(error.message)}</div>`));
        }
        rebuildCandidates();
        return redirect('/finance?note=' + encodeURIComponent(`已领取 ${key}`));
      }
      if (req.method === 'POST' && url.pathname === '/flow/claim-all') {
        let claimed = [];
        try {
          claimed = await claimAll();
        } catch (error) {
          return send(409, page('部分领取', `<div class="note bad">已领 ${claimed.length} 笔后中断：${htmlEscape(error.message)}</div>`));
        }
        return redirect('/finance?note=' + encodeURIComponent(`本次领取 ${claimed.length} 笔`));
      }
      if (req.method === 'POST' && url.pathname === '/flow/verify') {
        const { key } = await readBody(req);
        const entry = ledger.entries.find(item => item.requestKey === key);
        if (!entry) return send(404, page('查无台账', '<div class="note bad">台账中无此经办号。</div>'));
        const result = await fetchReceipt(sourceOrigin, key);
        entry.verify = result.found
          ? `${result.view.state}（来源凭据 ${result.view.receipt ?? entry.receiptId}）`
          : '来源查无受理（来源可能已复位，账面保留历史依据）';
        return redirect('/finance');
      }
      return send(404, page('查无页面', '<div class="note bad">查无此路径。</div>'));
    } catch (error) {
      return send(500, page('流程异常', `<div class="note bad">${htmlEscape(error.message)}</div>`));
    }
  });

  return { server, state, ledger, sync, claimAll };
}

// 直接运行时启动服务；被测试引用时只导出工厂。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const requestFile = process.env.REQUEST_FILE ?? 'requests/example.json';
  const request = JSON.parse(readFileSync(requestFile, 'utf8'));
  const sourceOrigin = process.env.SOURCE_ORIGIN ?? 'http://127.0.0.1:3100';
  const port = Number(process.env.PORT ?? 3200);
  const flow = createFlow({ sourceOrigin, request });
  flow.sync().catch(error => {
    flow.state.lastError = error.message;
    console.warn('首次同步失败：', error.message);
  });
  flow.server.listen(port, '127.0.0.1', () => {
    console.log(`凭据流程已启动 http://127.0.0.1:${port}（来源 ${sourceOrigin}）`);
  });
}
