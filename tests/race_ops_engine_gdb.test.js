'use strict';
// OPS整備(2026-09-21): GARON-DB(独自エンジン)の判定が、RaceOps(運用記録・通知リンク・仮想成績)で正しく扱われるかの検査。
// 実行: node tests/race_ops_engine_gdb.test.js
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const N = require('../boatcast_migration/scripts/lib/engine_notify');
const { createEventStore, computeInputHash } = require('../scripts/lib/realtime_event_store');
const A = require('../scripts/race_ops_analysis');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'engine_response_tamagawa_1r.json'), 'utf8'));
let p = 0, f = 0; const t = (n, fn) => { try { fn(); p++; console.log('PASS  ' + n); } catch (e) { f++; console.log('FAIL  ' + n + ': ' + e.message); } };

// Q画面の金額配分と、Node側の配分が同じ計算であること
const html = fs.readFileSync(path.join(__dirname, '..', 'garon_q_engine.html'), 'utf8').replace(/\r\n/g, '\n');
function fn(name) { const i = html.indexOf(`function ${name}(`); let d = 0; for (let k = html.indexOf('{', i); k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}' && --d === 0) return html.slice(i, k + 1); } throw new Error('x'); }
const sb = {}; vm.createContext(sb); vm.runInContext(fn('r06AllocateEqualReturn') + ';this.f=r06AllocateEqualReturn;', sb);

t('金額配分: Q画面(JS)と通知側(Node)が同じ結果・合計3,000円・100円単位', () => {
  for (const K of [5, 6, 8, 12]) {
    const pts = fx.engine.top.slice(0, K).map(x => x.combo);
    const a = N.allocateEqualReturn(pts, fx.oddsMap, 3000), b = sb.f(pts, fx.oddsMap, 3000);
    assert.deepEqual(a, b); assert.equal(a.reduce((x, y) => x + y, 0), 3000); assert.ok(a.every(v => v >= 100 && v % 100 === 0));
  }
});

function recordLikeScreening(dir, dateStr) {
  const file = path.join(dir, `events_${dateStr}.jsonl`); const store = createEventStore(dateStr, () => {}, file);
  const sel = N.selectBets(fx.engine, fx.oddsMap); const amounts = N.allocateEqualReturn(sel.combos, fx.oddsMap, 3000);
  const selectedBets = sel.combos.map((value, i) => ({ value, amount: amounts[i] }));
  const saved = store.recordJudgment({ raceId: `${dateStr}|多摩川|1`, date: dateStr, venue: '多摩川', raceNumber: 1, engine: 'GDB', engineSpecVersion: fx.engine.engine, qEngineVersion: null,
    evaluatedAt: '2026-09-21T06:00:00Z', deadlineTime: '23:30', entered: true, route: 'gdb', pEscape: fx.engine.boatWin[0], priorityEscape: false, judgeText: 'GARON-DB 確信度高', selectedBets, totalInvestment: amounts.reduce((x, y) => x + y, 0), inputHash: computeInputHash([], fx.oddsMap) });
  const n = store.recordNotificationSent(saved.eventId);
  return { file, saved, n, selectedBets };
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops_gdb_'));
const rec = recordLikeScreening(dir, '2026-09-21');

t('運用記録: 判定(engine=GDB・買い目と金額つき)と通知送信が保存され、再実行しても重複しない', () => {
  const lines = fs.readFileSync(rec.file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(lines.length, 2); assert.equal(lines[0].engine, 'GDB'); assert.equal(lines[0].route, 'gdb'); assert.equal(lines[0].entered, true);
  assert.equal(lines[0].totalInvestment, 3000); assert.ok(lines[0].selectedBets.every(b => b.amount >= 100));
  assert.equal(lines[1].eventType, 'notification_sent'); assert.equal(lines[1].judgmentEventId, lines[0].eventId);
  const again = recordLikeScreening(dir, '2026-09-21'); assert.equal(again.saved.deduped, true);
});
t('仮想成績: 的中すれば「配当×金額/100 − 3,000円」、外れれば−3,000円', () => {
  const j = fs.readFileSync(rec.file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)[0];
  const hitBet = j.selectedBets[0];
  const hit = A.computeVirtualNet(j, { chakuju: hitBet.value, payout: '¥1,490' });
  assert.equal(hit.hit, true); assert.equal(hit.net, Math.round(14.9 * hitBet.amount) - 3000);
  const miss = A.computeVirtualNet(j, { chakuju: '6-5-4', payout: '¥99,990' }); assert.equal(miss.hit, false); assert.equal(miss.net, -3000);
});
t('画面: 判定名(routeLabelOf)は GARON-DB では判定文、R07は従来の逃げ/非逃げ', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'race_ops_server.js'), 'utf8');
  const i = src.indexOf('function routeLabelOf('); let d = 0, code = ''; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) { code = src.slice(i, k + 1); break; } }
  const c = {}; vm.createContext(c); vm.runInContext(code + ';this.f=routeLabelOf;', c);
  assert.equal(c.f({ route: 'gdb', judgeText: 'GARON-DB 確信度高' }), 'GARON-DB 確信度高'); assert.equal(c.f({ route: 'escape' }), '逃げ'); assert.equal(c.f({ route: 'nonescape' }), '非逃げ');
});
t('天候: 通知側(スタート展示の表)とQ画面側(取込)が、同じ表から同じ風向・風速・波高を読む', () => {
  const A2 = require('../scripts/lib/engine-db-adapter');
  const tables = [[['天候', '風向', '風速', '波高', '気温', '水温'], ['くもり', '北 (追い風)', '1m', '1cm', '22.0℃', '22.0℃']], [['天候', '風向', '風速', '波高'], ['晴', '南西 (向い風)', '3m', '5cm']], [['天候', '風向', '風速', '波高'], ['雨', '', '', '']]];
  for (const tb of tables) { const q = A2.extractWeather({ startExhibitionRaw: { tables: [tb] } }); const n = N.parseWeatherTable(tb); assert.deepEqual(n, q); }
  assert.deepEqual(N.parseWeatherTable(null), { wdir: '', wind: null, wave: null });
  const inp = N.buildEngineInputFromCollected({ jo: '05', raceNumber: 1 }, { weatherTable: tables[0], playerStats: { boats: [] }, preRaceInfo: { ok: false } });
  assert.equal(inp.wind, 1); assert.equal(inp.wdir, '北');
});
console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
