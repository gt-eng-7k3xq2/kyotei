'use strict';
// 「既存BOATCAST収集データ→データバンク」橋渡し(scripts/lib/boatcast_databank_bridge.js)の検査。
// 実行: node tests/boatcast_databank_bridge.test.js
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { convertRawCollected, bridgeAll, regnoOfToban } = require('../scripts/lib/boatcast_databank_bridge');
let p = 0, f = 0; const t = (n, fn) => { try { fn(); p++; console.log('PASS  ' + n); } catch (e) { f++; console.log('FAIL  ' + n + ': ' + e.message); } };

function sampleRaw(overrides = {}) {
  const boats = [1, 2, 3, 4, 5, 6].map((w) => ({ waku: w, toban: `1${5000 + w}`, kyubetsu: 'A1', name: `選手${w}` }));
  const pre = [1, 2, 3, 4, 5, 6].map((w) => ({ waku: w, exhibitionTime: (6.7 + w / 100).toFixed(2), weightAndAdjustRaw: `${50 + w}.0 ${w % 2}.0`, tilt: '-0.5', partsExchange: w === 1 ? 'モーター' : '' }));
  const combos = []; for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) { if (b === a) continue; for (let c = 1; c <= 6; c++) { if (c === a || c === b) continue; combos.push({ first: a, second: b, third: c, odds: 5 + combos.length * 0.1 }); } }
  return { venue: '多摩川', jo: '05', raceNumber: 1, collectedAtISO: '2026-09-23T10:00:00.000Z',
    collected: { playerStats: { ok: true, boats }, preRaceInfo: { ok: true, boats: pre }, odds3Tan: { ok: true, combos } }, ...overrides };
}

t('regnoOfToban: 5桁のtobanから下4桁を登録番号として取り出す', () => { assert.equal(regnoOfToban('15088'), 5088); assert.equal(regnoOfToban(null), null); });

t('正常なraw_collected1件を、ingest_live_payloadの必須契約(race_id/observed_at/available_at/boats)を満たす形に変換する', () => {
  const r = convertRawCollected(sampleRaw(), '2026-09-23');
  assert.equal(r.ok, true);
  const p = r.payload;
  assert.equal(p.race_id, '20260923-05-01');
  assert.equal(p.observed_at, '2026-09-23T10:00:00.000Z'); assert.equal(p.available_at, '2026-09-23T10:00:00.000Z');
  assert.equal(p.boats.length, 6);
  assert.deepEqual(p.boats.map((b) => b.boat_no), [1, 2, 3, 4, 5, 6]);
  assert.equal(p.boats[0].regno, 5001);
  assert.ok(Math.abs(p.boats[0].exhibition_time - 6.71) < 1e-9);
  assert.equal(p.boats[0].weight, 51); assert.equal(p.boats[0].adjustment_weight, 1);
  assert.equal(p.boats[0].tilt, -0.5);
  assert.equal(p.odds.length, 120);
  assert.ok(p.odds.every((o) => /^[1-6]-[1-6]-[1-6]$/.test(o.combination)));
});

t('選手成績・直前情報が欠けていれば、理由つきで変換しない(取り込まない)', () => {
  assert.equal(convertRawCollected(sampleRaw({ collected: { playerStats: { ok: false }, preRaceInfo: sampleRaw().collected.preRaceInfo } }), '2026-09-23').ok, false);
  const noPre6 = sampleRaw(); noPre6.collected.preRaceInfo.boats = noPre6.collected.preRaceInfo.boats.slice(0, 5);
  assert.equal(convertRawCollected(noPre6, '2026-09-23').ok, false);
});

t('オッズが120通り揃っていなければ、展示だけ入れてオッズは空にする(全滅させない)', () => {
  const raw = sampleRaw(); raw.collected.odds3Tan.combos = raw.collected.odds3Tan.combos.slice(0, 100);
  const r = convertRawCollected(raw, '2026-09-23');
  assert.equal(r.ok, true); assert.equal(r.payload.odds.length, 0); assert.equal(r.payload.boats.length, 6);
});

t('regnoが取れない艇は、regnoフィールド自体を省く(Codex側で「艇番不一致」と誤判定させない)', () => {
  const raw = sampleRaw(); raw.collected.playerStats.boats[0].toban = '';
  const r = convertRawCollected(raw, '2026-09-23');
  assert.equal(r.ok, true); assert.ok(!('regno' in r.payload.boats[0]));
});

t('bridgeAll: raw_collected/<日付>/*.json を走査し、変換できたものだけ出力先へ書く(読み取り専用)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge_'));
  const rawRoot = path.join(tmp, 'raw'), outRoot = path.join(tmp, 'out');
  const day = path.join(rawRoot, '2026-09-23'); fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, '多摩川_1R_1.json'), JSON.stringify(sampleRaw()));
  fs.writeFileSync(path.join(day, '多摩川_2R_2.json'), JSON.stringify(sampleRaw({ raceNumber: 2, collected: { playerStats: { ok: false } } })));
  const before = fs.readFileSync(path.join(day, '多摩川_1R_1.json'), 'utf8');
  const r = bridgeAll(rawRoot, outRoot);
  assert.equal(r.scanned, 2); assert.equal(r.written, 1); assert.equal(r.skipped, 1);
  assert.equal(fs.readFileSync(path.join(day, '多摩川_1R_1.json'), 'utf8'), before, 'raw_collectedを書き換えていない');
  const out = JSON.parse(fs.readFileSync(path.join(outRoot, '2026-09-23', '多摩川_1R_1.json'), 'utf8'));
  assert.equal(out.race_id, '20260923-05-01');
});

console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
