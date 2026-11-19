// 时刻与日期工具：来源资料用当天当地时刻（"HH:MM" 或 "HH:MM:SS"），
// 凭据上的窗口需要带时区的 ISO 形式，便于财务按调度日核对。

export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text).trim());
  if (!match) throw new Error(`无法解析时刻: ${text}`);
  const [, hours, minutes, seconds] = match;
  if (Number(minutes) > 59 || Number(seconds ?? 0) > 59) {
    throw new Error(`时刻越界: ${text}`);
  }
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds ?? 0);
}

export function fmtClock(totalSeconds) {
  const pad = value => String(value).padStart(2, '0');
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function fmtRange(start, end) {
  return `${fmtClock(start)}–${fmtClock(end)}`;
}

// 某时区在某一 UTC 瞬时的偏移（分钟），用 Intl 求当地墙钟与 UTC 的差。
function tzOffsetMinutes(timezone, utcMillis) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMillis));
  const field = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const wallAsUtc = Date.UTC(
    Number(field.year), Number(field.month) - 1, Number(field.day),
    Number(field.hour) % 24, Number(field.minute), Number(field.second),
  );
  return Math.round((wallAsUtc - utcMillis) / 60000);
}

// 调度日 + 当日秒数 + 时区 → 带偏移的 ISO 串，如 2026-11-19T15:40:00+08:00。
export function localToIso(day, totalSeconds, timezone) {
  const pad = value => String(value).padStart(2, '0');
  const dayStartUtc = Date.parse(`${day}T00:00:00Z`);
  let offset = tzOffsetMinutes(timezone, dayStartUtc + totalSeconds * 1000);
  const utc = dayStartUtc + totalSeconds * 1000 - offset * 60000;
  offset = tzOffsetMinutes(timezone, utc); // 跨偏移边界时再校正一次
  const wall = new Date(utc + offset * 60000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
