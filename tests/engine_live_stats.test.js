'use strict';
// 実運用検証(scripts/lib/engine_live_stats.js と engine_live_verify.js のイベント読み込み)のテスト。実行: node tests/engine_live_stats.test.js
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const S = require('../scripts/lib/engine_live_stats');
let passed = 0; const failed = [];
function t(name, fn) { try { fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed.push(name); console.log('FAIL  ' + name + ': ' + e.message); } }
const combos = ['1-2-3', '1-3-2', '2-1-3', '1-2-4', '2-1-4', '1-4-2', '1-3-4', '3-1-2', '2-3-1', '1-4-3', '2-3-4', '3-2-1'];
const rec = (o) => ({ raceId: 'r', date: '2026-09-21', venue: '多摩川', raceNumber: 1, top1p: 0.13, level: '高', cum12: 0.66, topCombos: combos, notified: true, resultKind: 'confirmed', chakuju: '1-2-3', payoutYen: 800, ...o });

t('確信度: 0.111以上=高、0.087=中上、0.065=中、それ未満=低', () => { assert.equal(S.levelOf(0.111), '高'); assert.equal(S.levelOf(0.0869), '中'); assert.equal(S.levelOf(0.087), '中上'); assert.equal(S.levelOf(0.0649), '低'); });
t('払戻の数値化(¥や桁区切りを外す、無効はnull)', () => { assert.equal(S.payoutYen('¥1,230'), 1230); assert.equal(S.payoutYen(800), 800); assert.equal(S.payoutYen(''), null); assert.equal(S.payoutYen(null), null); });
t('的中: 上位K点に入っていれば的中(順位はtopCombosの並び)', () => {
  assert.equal(S.hitWithin(rec({ chakuju: '1-2-3' }), 6), true); assert.equal(S.hitWithin(rec({ chakuju: '1-4-2' }), 6), true); assert.equal(S.hitWithin(rec({ chakuju: '1-4-2' }), 5), false);
  assert.equal(S.hitWithin(rec({ chakuju: '6-5-4' }), 12), false);
});
t('均等買いの損益: 的中=払戻、はずれ=0、投資=100円×K', () => {
  const h = S.netEqualStake(rec({ chakuju: '1-2-3', payoutYen: 800 }), 10); assert.deepEqual([h.stake, h.ret, h.hit], [1000, 800, true]);
  const m = S.netEqualStake(rec({ chakuju: '6-5-4', payoutYen: 5000 }), 10); assert.deepEqual([m.stake, m.ret, m.hit], [1000, 0, false]);
});
t('集計: 確信度別・通知済み・日別・較正・未確定', () => {
  const rs = [rec({ raceId: 'a', chakuju: '1-2-3', payoutYen: 800 }), rec({ raceId: 'b', chakuju: '6-5-4', payoutYen: 3000 }), rec({ raceId: 'c', level: '低', top1p: 0.05, notified: false, chakuju: '1-3-2', payoutYen: 1500 }),
    rec({ raceId: 'd', resultKind: null, chakuju: null }), rec({ raceId: 'e', date: '2026-09-20', chakuju: '2-1-3', payoutYen: 600 })];
  const s = S.summarize(rs, { days: 14, nowDate: '2026-09-21' });
  assert.equal(s.totalRecorded, 5); assert.equal(s.totalConfirmed, 4); assert.equal(s.pending, 1);
  assert.equal(s.byLevel['高'].n, 3); assert.equal(s.byLevel['低'].n, 1); assert.equal(s.byLevel['高'].hit10, 2 / 3);
  assert.ok(Math.abs(s.byLevel['高'].roi10 - (800 + 600) / 3000) < 1e-9);
  assert.equal(s.notified.n, 3); assert.equal(s.daily.length, 2); assert.equal(s.daily[1].pending, 1);
  assert.equal(s.byLevel['高'].baseline.hit10, 0.659);
});
t('集計: 結果が未確定・不成立のレースは的中率の分母に入れない', () => {
  const s = S.summarize([rec({ resultKind: 'void_suspect', chakuju: null }), rec({ resultKind: 'confirmed', chakuju: '1-2-3' })]);
  assert.equal(s.totalConfirmed, 1); assert.equal(s.all.n, 1);
});
t('イベントログの読み込み: 予測と通知を結び付け、通知の有無を記録する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ev-')); process.env.GARON_ENGINE_EVENT_DIR = dir;
  const lines = [{ eventType: 'engine_judgment', venue: '多摩川', jo: '05', raceNumber: 1, deadlineTime: '12:30', top1p: 0.12, cum12: 0.66, boatWin: [0.5, 0.2, 0.1, 0.1, 0.06, 0.04], topCombos: combos },
    { eventType: 'engine_judgment', venue: '徳山', jo: '18', raceNumber: 5, deadlineTime: '13:00', top1p: 0.05, cum12: 0.4, boatWin: [0.3, 0.2, 0.2, 0.1, 0.1, 0.1], topCombos: combos },
    { eventType: 'engine_notification_sent', venue: '多摩川', jo: '05', raceNumber: 1, title: 't' }, { eventType: 'collection_failed', venue: '尼崎', raceNumber: 9 }];
  fs.writeFileSync(path.join(dir, 'boatcast_b01_events_2026-09-21.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  delete require.cache[require.resolve('../scripts/engine_live_verify')]; const V = require('../scripts/engine_live_verify'); const m = V.loadFromEvents();
  assert.equal(m.size, 2); assert.equal(m.get('2026-09-21|多摩川|1').notified, true); assert.equal(m.get('2026-09-21|徳山|5').notified, false); assert.equal(m.get('2026-09-21|多摩川|1').level, '高'); assert.equal(m.get('2026-09-21|徳山|5').level, '低');
  assert.equal(V.COMBOS.length, 120); assert.equal(V.COMBOS[0], '1-2-3'); assert.equal(V.COMBOS[119], '6-5-4');
});
t('レース一覧: 買い目つきは記録の買い目・金額で、無いものは上位10点100円の参考で損益を出す。結果待ちは損益null', () => {
  const base = { date: '2026-09-21', venue: '桐生', raceNumber: 7, deadlineTime: '18:13', top1p: 0.13, level: '高', notified: true, source: 'live', topCombos: ['1-2-3', '1-3-2', '1-2-4', '1-3-4', '2-1-3', '1-2-6', '1-3-6', '1-4-2', '1-4-3', '1-2-5'] };
  const rows = S.buildRaceRows([
    { ...base, bets: ['1-2-3', '1-3-2'], amounts: [1000, 2000], resultKind: 'confirmed', chakuju: '1-2-3', payoutYen: 500 },
    { ...base, raceNumber: 8, resultKind: 'confirmed', chakuju: '9-9-9', payoutYen: 100 },
    { ...base, raceNumber: 9 },
    { ...base, date: '2026-09-10', raceNumber: 1 },
  ], { days: 2, nowDate: '2026-09-21' });
  assert.equal(rows.length, 3, '古い日付は含めない');
  const r7 = rows.find(r => r.race === 7), r8 = rows.find(r => r.race === 8), r9 = rows.find(r => r.race === 9);
  assert.equal(r7.est, false); assert.equal(r7.stake, 3000); assert.equal(r7.hit, true); assert.equal(r7.net, 5 * 1000 - 3000);
  assert.equal(r8.est, true); assert.equal(r8.K, 10); assert.equal(r8.net, -1000); assert.equal(r9.net, null); assert.equal(r9.result, null);
});
console.log(`\n${passed} passed, ${failed.length} failed`); process.exit(failed.length ? 1 : 0);
