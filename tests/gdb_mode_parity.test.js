'use strict';
// GARON-DBモード(garon_q_engine.html)と、通知(boatcast_migration/scripts/lib/engine_notify.js)で、
// 「展開コメント用データ」「Xサマリー」の文面が完全に一致することを保証するテスト。書式を2か所に持つため、ずれたらここで検知する。
// 実行: node tests/gdb_mode_parity.test.js
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const vm = require('vm');
const N = require('../boatcast_migration/scripts/lib/engine_notify');
const html = fs.readFileSync(path.join(__dirname, '..', 'garon_q_engine.html'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0; const failed = [];
function t(name, fn) { try { fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed.push(name); console.log('FAIL  ' + name + ': ' + e.message); } }

// html内の関数宣言を、波括弧の対応を数えて取り出す
function fn(name) {
  const i = html.indexOf(`function ${name}(`); assert.ok(i >= 0, `function ${name} not found`);
  let d = 0, j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}') { d--; if (d === 0) return html.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
function decl(re) { const m = html.match(re); assert.ok(m, 'declaration not found: ' + re); return m[0]; }
const code = [
  decl(/const GARON_LABEL_CIRCLED=[^\n]*\n/), decl(/const GARON_ONE_CHAR_SURNAMES=[^\n]*\n/), decl(/const GARON_THREE_CHAR_SURNAMES=[^\n]*\n/), decl(/const GARON_NAME_OVERRIDES=[^\n]*\n/),
  fn('garonSurname'), fn('garonBoatLabel'), fn('garonNaturalGroupBets'), fn('garonEngineConfidence'), fn('gxEsc'), fn('gxChain'),
  decl(/const GX_COMBOS=\(function\(\)\{[^\n]*\n/),
  decl(/let garonGdbAuto=true;/), fn('garonGdbAutoSelect'), fn('garonGdbBetCount'), fn('garonGdbSurname'), fn('garonGdbHyoka'), fn('garonGdbState'), fn('garonGdbStatLine'), fn('garonGdbCommentData'), fn('garonGdbXSummary'),
].join('\n');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'engine_response_tamagawa_1r.json'), 'utf8'));
function makeEnv(K, eng, odds) {
  const sandbox = { garonEngine: eng || fx.engine, garonBoatcastPrepared: { oddsMap: odds === undefined ? fx.oddsMap : odds, venue: fx.venue, raceNum: fx.raceNum, deadline: fx.deadline }, garonEngineCtx: null, selectedBetCount: K, currentEngineState: null,
    currentCalcData: { racenum: '1' }, aiTenkaiLine: null, calcGoseiOdds: () => null, document: { getElementById: () => null, querySelectorAll: () => [] }, console };
  vm.createContext(sandbox); vm.runInContext(code + '\n;this.api={garonGdbCommentData,garonGdbXSummary,garonGdbState,garonGdbHyoka,garonEngineConfidence,garonGdbAutoSelect};' + (K === 'auto' ? '' : ';garonGdbAuto=false;'), sandbox);
  return sandbox.api;
}
const meta = { venue: fx.venue, raceNumber: 1, deadlineTime: fx.deadline };
const collected = { deadlineTime: fx.deadline, playerStats: { boats: fx.engine.explain.boats.map(b => ({ waku: b.lane, name: b.name })) } };
const nameOf = {}; collected.playerStats.boats.forEach(b => { nameOf[b.waku] = b.name; });

t('展開コメント用データ: 通知(Node)とQ画面(JS)が、12点のとき完全に同じ文面', () => {
  const api = makeEnv('auto');
  const nodeText = N.buildCommentData(fx.engine, meta, nameOf, { oddsMap: fx.oddsMap });
  const jsText = api.garonGdbCommentData();
  assert.equal(jsText, nodeText);
});
t('Xサマリー(X用): 通知(Node)とQ画面(JS)が完全に同じ文面', () => {
  const api = makeEnv('auto');
  assert.equal(api.garonGdbXSummary('x', false), N.buildXSummary(fx.engine, meta, nameOf, fx.oddsMap));
});
t('note用サマリー(通知の1通目): 通知(Node)とQ画面(JS)が完全に同じ文面', () => {
  const api = makeEnv('auto'); assert.equal(api.garonGdbXSummary('note', false), N.buildNoteSummary(fx.engine, meta, nameOf, fx.oddsMap));
});
t('評価順の矢印: NodeとJSが同じ', () => {
  const api = makeEnv(12); assert.equal(api.garonGdbHyoka(fx.engine.boatWin), N.hyokaOrder(fx.engine.boatWin));
});
t('点数ボタン: 点数を変えると、買い目・コメント用データ・的中確率の目安が連動する', () => {
  const a6 = makeEnv(6), a12 = makeEnv(12);
  assert.equal(a6.garonGdbState().betsRaw.length, 6); assert.equal(a12.garonGdbState().betsRaw.length, 12);
  assert.ok(a6.garonGdbCommentData().includes('■最終買い目(6点)'));
  const g = t => Number(t.match(/G\.RATE (\d+)%/)[1]); assert.ok(g(a6.garonGdbXSummary('x')) < g(a12.garonGdbXSummary('x')));
});
t('買い目の種別: 軸(1位の艇)から始まる買い目は「GDB本線」、それ以外は「GDB抑え」', () => {
  const st = makeEnv(12).garonGdbState(); const axis = st.axes[0].boat;
  for (const b of st.betsRaw) assert.equal(b.type, Number(b.val.split('-')[0]) === axis ? 'GDB本線' : 'GDB抑え');
  assert.equal(st.mode, 'gdb'); assert.equal(st.dbg.selectedPoints.length, 12);
});
t('note用: 評価順・本線・抑え・署名がそろう。買い目は買い目表と一致', () => {
  const api = makeEnv(12); const text = api.garonGdbXSummary('note', false); const st = api.garonGdbState();
  assert.ok(/評価順：1[>\d]+/.test(text)); assert.ok(text.includes('本線：')); assert.ok(text.trim().endsWith('G.'));
  const vals = st.betsRaw.map(b => b.val); const shown = [...text.matchAll(/(\d)-(\d)-(\d+)/g)].flatMap(m => [...m[3]].map(c => `${m[1]}-${m[2]}-${c}`));
  assert.deepEqual([...new Set(shown)].sort(), [...vals].sort());
});
t('エンジンが無いとき(未読込)は、空・警告になり、例外を出さない', () => {
  const sandbox = { garonEngine: null, garonBoatcastPrepared: null, garonEngineCtx: null, selectedBetCount: 12, currentEngineState: null, currentCalcData: {}, document: { getElementById: () => null, querySelectorAll: () => [] } };
  vm.createContext(sandbox); vm.runInContext(code + '\n;this.api={garonGdbCommentData,garonGdbXSummary,garonGdbState};', sandbox);
  assert.equal(sandbox.api.garonGdbState(), null); assert.equal(sandbox.api.garonGdbXSummary('x'), ''); assert.match(sandbox.api.garonGdbCommentData(), /結果がありません/);
});
// ---- 買い目の点数(自動): 規則の検査と、通知(Node)とQ画面(JS)の一致 ----
function scen(boatWin, oddsScale) {
  const eng = JSON.parse(JSON.stringify(fx.engine)); eng.boatWin = boatWin;
  const odds = {}; for (const c of Object.keys(fx.oddsMap)) odds[c] = fx.oddsMap[c] * oddsScale;
  return { eng, odds };
}
t('自動点数: 逃げ濃厚(1号艇過半数)は最大6点、荒れ想定は最大12点、最低5点', () => {
  const nige = scen([0.6, 0.15, 0.1, 0.07, 0.05, 0.03], 1); assert.ok(N.selectBets(nige.eng, nige.odds).K <= 6);
  const are = scen([0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 5); const r = N.selectBets(are.eng, are.odds); assert.ok(r.K > 6 && r.K <= 12, 'K=' + r.K);
  const low = scen([0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 0.3); assert.equal(N.selectBets(low.eng, low.odds).K, 5);
});
t('自動点数: 合成オッズが2.5倍以上を保つ(最低5点を除く)', () => {
  for (const sc of [1, 2, 5]) { const x = scen([0.3, 0.25, 0.2, 0.12, 0.08, 0.05], sc); const r = N.selectBets(x.eng, x.odds); if (r.K > 5) assert.ok(r.gosei >= 2.5, 'g=' + r.gosei); }
});
t('自動点数: オッズ無しは、逃げ6点・それ以外8点', () => {
  assert.equal(N.selectBets(scen([0.6, 0.15, 0.1, 0.07, 0.05, 0.03], 1).eng, null).K, 6);
  assert.equal(N.selectBets(scen([0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 1).eng, null).K, 8);
});
t('自動点数: 通知(Node)とQ画面(JS)が、あらゆる場面で同じ点数・同じ文面', () => {
  const cases = [[[0.6, 0.15, 0.1, 0.07, 0.05, 0.03], 1], [[0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 5], [[0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 0.3], [[0.45, 0.2, 0.15, 0.1, 0.06, 0.04], 2], [[0.5, 0.2, 0.15, 0.1, 0.03, 0.02], 3]];
  for (const [bw, sc] of cases) {
    const x = scen(bw, sc); const api = makeEnv('auto', x.eng, x.odds);
    assert.equal(api.garonGdbState().betsRaw.length, N.selectBets(x.eng, x.odds).K);
    assert.equal(api.garonGdbXSummary('note', false), N.buildNoteSummary(x.eng, meta, nameOf, x.odds));
    assert.equal(api.garonGdbCommentData(), N.buildCommentData(x.eng, meta, nameOf, { oddsMap: x.odds }));
  }
  const y = scen([0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 1); assert.equal(makeEnv('auto', y.eng, null).garonGdbState().betsRaw.length, 8);
});

t('見送り: 最低5点でも合成2.5倍に届かないレースは skip=true、通知は作られない。届くレースは skip=false', () => {
  const thin = scen([0.7, 0.12, 0.08, 0.05, 0.03, 0.02], 0.3); const r = N.selectBets(thin.eng, thin.odds); assert.equal(r.skip, true); assert.ok(r.gosei < 2.5);
  const ok = scen([0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 5); assert.equal(N.selectBets(ok.eng, ok.odds).skip, false);
  assert.equal(N.selectBets(thin.eng, null).skip, false, 'オッズ無しでは判定しない');
  const collected = { playerStats: { boats: [] }, odds3Tan: { ok: true, combos: Object.entries(thin.odds).map(([k, v]) => { const [a, b, c] = k.split('-').map(Number); return { first: a, second: b, third: c, odds: v }; }) } };
  thin.eng.ok = true; thin.eng.top1p = 0.2; assert.equal(N.buildEngineNotifications(thin.eng, meta, collected), null);
});
t('見送り: 通知(Node)とQ画面(JS)の見送り判定・合成オッズが一致', () => {
  for (const [bw, sc] of [[[0.7, 0.12, 0.08, 0.05, 0.03, 0.02], 0.3], [[0.6, 0.15, 0.1, 0.07, 0.05, 0.03], 1], [[0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 5], [[0.5, 0.2, 0.15, 0.1, 0.03, 0.02], 0.5]]) {
    const x = scen(bw, sc); const a = N.selectBets(x.eng, x.odds); const j = makeEnv('auto', x.eng, x.odds).garonGdbAutoSelect(x.eng, x.odds);
    assert.equal(j.skip, a.skip); assert.equal(j.K, a.K); assert.ok(Math.abs(j.gosei - a.gosei) < 0.01);
  }
});
t('通知1通目のタイトルに、買い目の点数と合成オッズが入る(投稿文の本文には入れない)', () => {
  const x = scen([0.3, 0.25, 0.2, 0.12, 0.08, 0.05], 5); x.eng.ok = true; x.eng.top1p = 0.2;
  const collected = { playerStats: { boats: [] }, odds3Tan: { ok: true, combos: Object.entries(x.odds).map(([k, v]) => { const [a, b, c] = k.split('-').map(Number); return { first: a, second: b, third: c, odds: v }; }) } };
  const msgs = N.buildEngineNotifications(x.eng, meta, collected); const sel = N.selectBets(x.eng, N.oddsMapOf(collected));
  assert.ok(msgs[0].title.includes(`(${sel.K}点・合成${sel.gosei}倍)`), msgs[0].title); assert.ok(!msgs[0].body.includes('合成'));
});
console.log(`\n${passed} passed, ${failed.length} failed`); process.exit(failed.length ? 1 : 0);
