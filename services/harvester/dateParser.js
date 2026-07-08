let _refStr = null;

function _getNowStr() {
  if (_refStr) return _refStr;
  return new Date().toISOString().split('T')[0];
}

function _getNowDate() {
  if (_refStr) {
    const [y, m, d] = _refStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

export function setReferenceDate(dateStr) {
  if (!dateStr) { _refStr = null; return; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    _refStr = dateStr;
  }
}

export function yesterdayString() {
  const d = _getNowDate();
  d.setDate(d.getDate() - 1);
  return fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function normalizeDate(raw) {
  if (!raw) return null;
  const str = raw.trim();

  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  const dmy = str.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dmy) {
    const d = parseInt(dmy[1], 10);
    const m = monthIndex(dmy[2]);
    const y = parseInt(dmy[3], 10);
    if (m !== -1) return fmt(y, m + 1, d);
  }

  const mdy = str.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy) {
    const m = monthIndex(mdy[1]);
    const d = parseInt(mdy[2], 10);
    const y = parseInt(mdy[3], 10);
    if (m !== -1) return fmt(y, m + 1, d);
  }

  const slashDmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashDmy) {
    return fmt(
      parseInt(slashDmy[3], 10),
      parseInt(slashDmy[2], 10),
      parseInt(slashDmy[1], 10)
    );
  }

  try {
    const d = new Date(str);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  } catch {}

  return null;
}

export function isToday(dateStr) {
  const norm = normalizeDate(dateStr);
  return norm === _getNowStr();
}

export function todayString() {
  return _getNowStr();
}

export function todayHuman() {
  const d = _getNowDate();
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

export function todayParts() {
  const d = _getNowDate();
  return {
    day:   d.getDate(),
    month: d.toLocaleString('en', { month: 'long' }).toLowerCase(),
    year:  d.getFullYear(),
  };
}

const MONTHS = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
  'jan','feb','mar','apr','may','jun',
  'jul','aug','sep','oct','nov','dec',
];

function monthIndex(name) {
  const lower = name.toLowerCase();
  const full  = MONTHS.indexOf(lower);
  if (full !== -1 && full < 12) return full;
  const abbr  = MONTHS.indexOf(lower);
  if (abbr !== -1 && abbr >= 12) return abbr - 12;
  for (let i = 0; i < 12; i++) {
    if (MONTHS[i].startsWith(lower.slice(0, 3))) return i;
  }
  return -1;
}

function fmt(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
