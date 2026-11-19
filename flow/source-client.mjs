// 演练来源的只读/受理接口封装。

async function getJson(origin, path) {
  const response = await fetch(origin + path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${path} 来源回应 ${response.status}`);
  return response.json();
}

export async function fetchInputs(origin) {
  const [meta, windows, outlets, access, samples, baselines] = await Promise.all([
    getJson(origin, '/'),
    getJson(origin, '/dispatch/windows'),
    getJson(origin, '/partners/outlets'),
    getJson(origin, '/partners/access'),
    getJson(origin, '/partners/samples'),
    getJson(origin, '/dispatch/baselines'),
  ]);
  return { phase: meta.phase, windows, outlets, access, samples, baselines };
}

// 提交确认或冲正凭据。返回 { ok, status, body }；409 等也原样带回，
// 由调用方决定如何向财务展示。
export async function postReceipt(origin, payload) {
  const response = await fetch(origin + '/finance/receipts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: response.ok, status: response.status, body: await response.json() };
}

export async function fetchReceipt(origin, requestKey) {
  const response = await fetch(
    origin + '/finance/receipts?requestKey=' + encodeURIComponent(requestKey),
    { headers: { accept: 'application/json' } });
  if (response.status === 404) return { found: false };
  if (!response.ok) throw new Error(`核对 ${requestKey} 来源回应 ${response.status}`);
  return { found: true, view: await response.json() };
}
