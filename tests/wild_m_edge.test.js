'use strict';
// M(edge)(2026-11-13運用開始、CEO決定、案件GARON-20261113-001)。判定(wild_live)・画面(wild_template.html)・通知・実績の集計・稼働状況が同じ結果になること。
const assert = require('assert'), fs = require('fs'), path = require('path');
const W = require('../scripts/lib/wild_live');
const T = require('../scripts/lib/wild_tier_perf');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ' + name); pass++; } catch (e) { console.log('FAIL ' + name + ': ' + e.message); fail++; } };

// 12点の各点・120通り全部が同じオッズ/確率の合成カード: 市場の12点確率=12/120=0.1、エンジンの12点確率=pct*12/100 → edge=pct*1.2
const synth = (pct) => {
  const combos = {}; const L = []; let k = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) { if (a === b || b === c || a === c) continue; const key = a + '-' + b + '-' + c; combos[key] = { odds: 54, enginePct: pct }; if (a !== 1 && k < 12) { L.push({ combo: key, odds: 54, enginePct: pct }); k++; } }
  return { overview: { upset: 0.5 }, entry: {}, combos, aiPick: { lines: L } };
};
const independent = (card) => {   // 検証コード(research/buyline_opt_20261112/m_entry.py)と同じ式を、別に書いた版
  const ls = (card.aiPick.linesCur || card.aiPick.lines).slice(0, 12), co = card.combos;
  const tot = Object.values(co).reduce((s, v) => s + 1 / v.odds, 0);
  const mk = ls.reduce((s, l) => s + 1 / l.odds, 0) / tot, p12 = ls.reduce((s, l) => s + l.enginePct, 0) / 100;
  return p12 / mk;
};
t('edgeの式: 合成カードで edge=pct×1.2、1.25以上でM(edge)', () => {
  assert.ok(Math.abs(W.edgeValue(synth(1.0)) - 1.2) < 1e-9);
  assert.ok(W.edgeValue(synth(1.0417)) >= W.M_EDGE_MIN);   // 1.25
  assert.ok(W.edgeValue(synth(1.0)) < W.M_EDGE_MIN);
  assert.strictEqual(W.M_EDGE_MIN, 1.25);
});
t('edgeが作れないカード(オッズ欠け・12点未満・120通り未満)は null=M(edge)にしない', () => {
  const c = synth(1.5); delete c.combos['1-2-3']; assert.strictEqual(W.edgeValue(c), null);
  const d = synth(1.5); d.aiPick.lines.length = 11; assert.strictEqual(W.edgeValue(d), null);
  const e = synth(1.5); e.aiPick.lines[0].odds = 0; assert.strictEqual(W.edgeValue(e), null);
});
const days = (() => { const dir = W.WILD_DIR; return fs.readdirSync(dir).filter(f => /^index_\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(6, 16)).filter(d => d >= '2026-11-09').sort(); })();
t('実カードで edgeValue が独立に書いた式と一致(11/9以降の全カード)', () => {
  let n = 0, bad = 0;
  for (const d of days) { let files = []; try { files = fs.readdirSync(W.cardDir(d)); } catch (e) { continue; }
    for (const f of files) { const c = W.readJson(path.join(W.cardDir(d), f), null); if (!c || !c.card) continue; const card = c.card, co = card.combos || {};
      if (Object.keys(co).length < 120 || Object.values(co).some(v => !(v.odds > 0))) { if (Object.keys(co).length >= 120) assert.strictEqual(W.edgeValue(card), null, f + ' オッズ欠けはnull'); continue; } const ls = (card.aiPick.linesCur || card.aiPick.lines || []).slice(0, 12); if (ls.length < 12 || !ls.every(l => l.odds > 0)) continue;
      n++; const a = W.edgeValue(card), b = independent(card); if (Math.abs(a - b) > 0.0006) bad++; } }
  assert.ok(n > 300, 'カードが少ない ' + n); assert.strictEqual(bad, 0, bad + '件が不一致');
  console.log('   (カード' + n + '件で一致)');
});
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'wild_template.html'), 'utf8');
const mOfCard = new Function(tplSrc.slice(tplSrc.indexOf('const M_UPSET_MIN'), tplSrc.indexOf('function rankTag')) + '; return mOfCard;')();
t('画面(wild_template.html)の mOfCard と、判定・edge・M(edge)の別が全カードで一致', () => {
  let n = 0, m = 0, me = 0;
  for (const d of days) { let files = []; try { files = fs.readdirSync(W.cardDir(d)); } catch (e) { continue; }
    for (const f of files) { const c = W.readJson(path.join(W.cardDir(d), f), null); if (!c || !c.card) continue; n++;
      const x = W.mInfo(c.card), y = mOfCard(c.card); assert.strictEqual(!!x, !!y, f);
      if (x) { m++; assert.strictEqual(!!x.mEdge, !!y.mEdge, f + ' mEdge'); assert.ok((x.edge == null && y.edge == null) || Math.abs(x.edge - y.edge) < 1e-9, f + ' edge'); if (x.mEdge) me++; } } }
  assert.ok(n > 300 && m > 20, 'n=' + n + ' m=' + m); console.log('   (カード' + n + '件、M ' + m + '件、うちM(edge) ' + me + '件で一致)');
});
t('M(edge)は、Mの内数(M(edge)でないMが存在し、M(edge)はMでないレースに付かない)', () => {
  let m = 0, me = 0, notM = 0;
  for (const d of days) { let files = []; try { files = fs.readdirSync(W.cardDir(d)); } catch (e) { continue; }
    for (const f of files) { const c = W.readJson(path.join(W.cardDir(d), f), null); if (!c || !c.card) continue; const x = W.mInfo(c.card); if (x) { m++; if (x.mEdge) me++; } else if (c.card.entry && !c.card.entry.rank) { /* Mでない */ notM++; } } }
  assert.ok(me > 0 && me < m, 'M ' + m + ' M(edge) ' + me); console.log('   (M ' + m + '件のうちM(edge) ' + me + '件=' + Math.round(me / m * 100) + '%)');
});
const base = { venue: '津', race: 5, date: '2026-11-13', deadline: '15:00', upset: 0.5, top: { winner: 3, tech: 'まくり差し', scenarioPct: 21.2 } };
const mkRow = (edge, val) => Object.assign({ m: true, mLines: Array.from({ length: 12 }, (_, i) => ({ combo: '2-3-' + (i + 1), odds: 54 })), mGosei: 4.5, mEdge: edge, mEdgeVal: val }, base);
t('通知: M(edge)はタイトルに(edge)とedgeの値、Mは従来どおり', () => {
  const dl = W.deadlineMs('2026-11-13', '15:00') - 600000;
  const a = W.wildMNotificationFor(mkRow(true, 1.32), dl), b = W.wildMNotificationFor(mkRow(false, 1.05), dl);
  assert.strictEqual(a.key, 'M_津_5'); assert.strictEqual(b.key, 'M_津_5');   // 同じレースで二重に通知しない
  assert.ok(a.title.startsWith('【WILD M(edge)】津5R'), a.title); assert.ok(a.body.includes('edge1.32。'), a.body);
  assert.ok(b.title.startsWith('【WILD M】津5R'), b.title); assert.ok(!b.body.includes('edge'), b.body);
  assert.strictEqual(a.priority, b.priority);   // 音・優先度は変えない
});
t('M(edge)の実績集計: edge + それ以外 = M全体(運用開始日以降)', () => {
  const r = T.computeMEdgePerf(); assert.ok(r && r.edge && r.rest && r.all); assert.strictEqual(r.from, T.MEDGE_FROM);
  const n = (x) => (x && x.all && x.all.n) || 0; assert.strictEqual(n(r.edge) + n(r.rest), n(r.all));
  const old = T.computeMPerf(); assert.ok(old && old.all && old.all.n >= 300, '従来のM集計が壊れていない');
});
t('稼働状況: M(edge)の通知数・該当・実績・行のedgeが入る', () => {
  const S = require('../scripts/lib/wild_status'); const st = S.computeWildStatus(Date.now(), {});
  assert.ok('mEdgeNotified' in st && 'mEdgeCardsToday' in st && 'mEdgePerf' in st);
  assert.ok(st.mEdgeNotified <= st.mNotified && st.mEdgeCardsToday <= st.mCardsToday);
  for (const r of st.entryRaces) if (r.tier === 'M') assert.ok(typeof r.edge === 'boolean');
});
t('一覧の行(indexRow)にmEdge・mEdgeValが付く', () => {
  const d = days[days.length - 1]; const idx = W.readJson(W.indexFile(d), { races: [] });
  const any = idx.races.find(r => r.m); if (!any) return; assert.ok('mEdge' in any && 'mEdgeVal' in any);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
