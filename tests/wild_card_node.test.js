'use strict';
// GARON-WILD カード作成(Node側)のテスト。エラーの扱い・会場コード・最新の生データの選び方・判定の取り出し方。本物のログには触れない。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildWildCard, latestRaw, judgmentFor, VENUE_CODE } = require('../scripts/wild_card');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log('  PASS: ' + name); pass++; } else { console.log('  FAIL: ' + name); fail++; } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wild-'));
const DATE = '2026-10-01';

console.log('=== 会場コード ===');
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'sg_narutou.html'), 'utf8');
  const m = html.match(/const OFFICIAL_VENUE_CODE=\{([^}]*)\}/);
  const official = {}; for (const [, k, v] of m[1].matchAll(/"([^"]+)"\s*:\s*"(\d+)"/g)) official[k] = Number(v);
  check('24会場すべてが、公式の会場コード(sg_narutou.html)と一致', Object.keys(official).length === 24 && Object.entries(official).every(([k, v]) => VENUE_CODE[k] === v));
}

console.log('=== 最新の生データの選び方 ===');
{
  const raw = path.join(TMP, 'raw'); const d = path.join(raw, DATE); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '常滑_4R_1000.json'), JSON.stringify({ venue: '常滑', marker: 'old' }));
  fs.writeFileSync(path.join(d, '常滑_4R_2000.json'), JSON.stringify({ venue: '常滑', marker: 'new' }));
  fs.writeFileSync(path.join(d, '常滑_5R_3000.json'), JSON.stringify({ venue: '常滑', marker: 'other' }));
  check('同じレースが複数あれば、保存時刻が新しい方を使う', latestRaw(DATE, '常滑', 4, raw).marker === 'new');
  check('別のレース(5R)は、混ざらない', latestRaw(DATE, '常滑', 5, raw).marker === 'other');
  check('無ければnull', latestRaw(DATE, '常滑', 9, raw) === null && latestRaw('2000-01-01', '常滑', 4, raw) === null);
}

console.log('=== 判定(engine_judgment)の取り出し ===');
{
  const ev = path.join(TMP, 'events'); fs.mkdirSync(ev, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(ev, `boatcast_b01_events_${DATE}.jsonl`),
    line({ eventType: 'engine_judgment', venue: '常滑', raceNumber: 4, probs: [1], marker: 'first' }) +
    line({ eventType: 'engine_error', venue: '常滑', raceNumber: 4 }) +
    line({ eventType: 'engine_judgment', venue: '常滑', raceNumber: 4, probs: [2], marker: 'last' }) +
    line({ eventType: 'engine_judgment', venue: '戸田', raceNumber: 4, probs: [3], marker: 'other' }) + 'これは壊れた行\n');
  check('同じレースの判定が複数あれば、最後の1件', judgmentFor(DATE, '常滑', 4, ev).marker === 'last');
  check('別の会場の判定は混ざらない・壊れた行があっても読める', judgmentFor(DATE, '戸田', 4, ev).marker === 'other');
  check('判定が無ければnull', judgmentFor(DATE, '桐生', 1, ev) === null && judgmentFor('2000-01-01', '常滑', 4, ev) === null);
}

console.log('=== エラーの扱い(例外を出さず、ok:falseで返す) ===');
{
  const r = buildWildCard({ venue: '常滑', race: 4, date: DATE, rawRoot: path.join(TMP, 'raw-none'), eventsRoot: path.join(TMP, 'events') });
  check('生データが無ければ ok:false と理由', r.ok === false && /生データがありません/.test(r.error));
}

console.log('=== 実データとの整合(本物のDB・表がある場合だけ) ===');
{
  const tables = path.join(__dirname, '..', 'engine_db', 'data', 'wild_tables.json');
  if (fs.existsSync(tables)) {
    const t = JSON.parse(fs.readFileSync(tables, 'utf8'));
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const l = t.lines['3|まくり差し']; const p1 = Object.entries(l).filter(([k]) => k.startsWith('1-')).reduce((s, [, v]) => s + v, 0) / sum(l);
    check('「3号艇まくり差し → 2着が1号艇」が、検証(60.9%)と一致(±1ポイント)', Math.abs(p1 - 0.609) < 0.01);
    const l2 = t.lines['2|差し']; const q = Object.entries(l2).filter(([k]) => k.startsWith('1-')).reduce((s, [, v]) => s + v, 0) / sum(l2);
    check('「2号艇差し → 2着が1号艇」が、検証(61.6%)と一致(±1ポイント)', Math.abs(q - 0.616) < 0.01);
    check('レース数が20万件以上', t.races > 200000);
  } else console.log('  (表が未作成のためスキップ)');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`); process.exit(fail ? 1 : 0);
