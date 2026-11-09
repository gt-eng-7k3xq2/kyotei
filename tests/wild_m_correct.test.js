'use strict';
// Mの補正(2026-11-09): (1)画面のおまかせ案=補正後12点・除外・切替 (2)m_correct_apply の安全な無効化 (3)mInfo(通知・成績)が補正後の判定を使う (4)実カードでのPython出力
const fs = require('fs'), path = require('path'), assert = require('assert'), { spawnSync } = require('child_process');
const html = fs.readFileSync(path.join(__dirname, '..', 'garon_wild.html'), 'utf8');
const g = re => { const m = html.match(re); if (!m) throw new Error('抽出失敗 ' + re); return m[0]; };
const code = [g(/const PLAN_POINTS[^\n]*\n/), g(/const X_ODDS_MIN[^\n]*\n/), g(/const M_UPSET_MIN[^\n]*\n/), g(/const PLAN_MIN_POINTS[\s\S]*?function variableK[\s\S]*?return n;\s*\}/), g(/function planKey[^\n]*\n/), g(/function hasExcluded[^\n]*\n/), g(/function mOfCard[\s\S]*?\n\}\r?\n/), g(/function mCorrOn[^\n]*\n/), g(/function mDetOn[^\n]*\n/), g(/function autoPlan[\s\S]*?\n\}\r?\n/), g(/function mergeBlocks[\s\S]*?return out;\s*\}/), g(/const SAMPLES = [^\n]*\n/)].join('\n');
const F = new Function(code + ';let S=null;return {autoPlan,mergeBlocks,mOfCard,mCorrOn,SAMPLES,setS:v=>{S=v;}};')();
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + e.message.split('\n')[0]); } };
const base = JSON.parse(JSON.stringify(F.SAMPLES[0].card)), info = base.combos;
const ks = Object.keys(info).filter(k => info[k].odds && !k.startsWith('1-')).sort((a, b) => info[a].odds - info[b].odds);
const corr = ks.slice(20, 33), lines = corr.slice(0, 12).map(c => ({ combo: c, odds: info[c].odds, enginePct: info[c].enginePct, corrPct: 1 }));
const mk = (mc, rank) => { const c = JSON.parse(JSON.stringify(base)); c.entry = Object.assign({}, c.entry, { rank: rank || null }); c.overview.upset = 0.2; c.aiPick = Object.assign({}, c.aiPick, { lines: ks.slice(0, 12).map(k => ({ combo: k, odds: 5, enginePct: 0.1 })) }); c.aiPick.mCorr = mc; return c; };
const M = mk({ applied: true, isM: true, up: 0.5, gosei: 4, p12: 0.2, lines });
t('補正が適用されMの判定ならM(エンジンの規則では対象外のカードでも)', () => { F.setS({}); assert.ok(F.mOfCard(M) && F.mOfCard(M).corrected); });
t('補正でMでないと判定されたカードはM判定にならない', () => { F.setS({}); const c = mk({ applied: true, isM: false, lines: [] }); assert.equal(F.mOfCard(c), null); });
t('S/A/Bのカードは、補正があってもMにならない', () => { F.setS({}); assert.equal(F.mOfCard(mk({ applied: true, isM: true, up: 0.5, gosei: 4, p12: 0.2, lines }, 'S')), null); });
t('おまかせ案=補正後の12点', () => { F.setS({}); const cs = F.mergeBlocks(F.autoPlan(M, null, []).blocks); assert.deepEqual(cs.slice().sort(), corr.slice(0, 12).sort()); });
t('艇を消すと、その艇を含まない12点になる', () => { F.setS({}); const cs = F.mergeBlocks(F.autoPlan(M, null, [2]).blocks); assert.ok(cs.every(c => !c.split('-').includes('2')) && cs.length <= 12); });
t('S.mcorrOff=true で従来のAIおすすめに戻る', () => { F.setS({ mcorrOff: true }); const cs = F.mergeBlocks(F.autoPlan(M, null, []).blocks); assert.notDeepEqual(cs.slice().sort(), corr.slice(0, 12).sort()); });
t('X・安定枠のときは補正の買い目を使わない', () => { F.setS({ xmode: true }); const cs = F.mergeBlocks(F.autoPlan(M, null, []).blocks); assert.notDeepEqual(cs.slice().sort(), corr.slice(0, 12).sort()); });
const W = require('../scripts/lib/wild_live');
t('mInfo: 補正が適用されたカードは補正後の12点で判定・通知する', () => { const mi = W.mInfo(M); assert.ok(mi && mi.corrected && mi.lines.length === 12 && mi.lines[0].combo === lines[0].combo); });
t('mInfo: 補正でMでないカードは null(エンジンの規則でM該当でも)', () => { const c = mk({ applied: true, isM: false, lines: [] }); c.overview.upset = 0.6; assert.equal(W.mInfo(c), null); });
t('mInfo: 補正が適用されなかったカードは、これまでのエンジンの規則', () => { const c = mk({ applied: false, reason: 'disabled' }); const a = W.mInfo(c); const b = W.mInfo(Object.assign({}, c, { aiPick: Object.assign({}, c.aiPick, { mCorr: undefined }) })); assert.deepEqual(a, b); });
const A = require('../scripts/lib/m_correct_apply');
t('適用開始日(2026-11-10)より前は何もしない', () => { assert.equal(A.applyMCorrect({ ok: true, card: { raceDate: '2026-11-08', aiPick: {} } }, {}).reason, 'before_start'); });
t('停止ファイルがあると何もしない', () => { const tmp = path.join(require('os').tmpdir(), 'mc_disable_test'); fs.writeFileSync(tmp, 'x'); try { const r = A.applyMCorrect({ ok: true, card: { raceDate: '2026-11-09', aiPick: {}, combos: {} } }, { boats: [] }, { disableFile: tmp }); assert.equal(r.reason, 'disabled'); } finally { fs.unlinkSync(tmp); } });
t('直前情報が無いカードは補正しない(エンジンの規則のまま)', () => { const r = A.applyMCorrect({ ok: true, card: { raceDate: '2026-11-09', aiPick: {}, combos: {} } }, { boats: [] }); assert.equal(r.reason, 'preinfo_missing'); });
t('例外が起きてもカード作成を止めない', () => { const r = A.applyMCorrect({ ok: true, card: { raceDate: '2026-11-09', aiPick: null } }, {}); assert.equal(r.applied, false); });
// 実カード(Python)
const CK = []; for (let x = 1; x <= 6; x++) for (let y = 1; y <= 6; y++) for (let z = 1; z <= 6; z++) if (x !== y && y !== z && x !== z) CK.push(`${x}-${y}-${z}`);
const dir = path.join(__dirname, '..', 'logs', 'wild', 'cards', '2026-11-08'); let ran = 0;
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
  if (ran >= 3) break; const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).card; const [ven, rr] = f.slice(0, -5).split(/_(?=\d+R$)/);
  const rawDir = path.join(__dirname, '..', 'boatcast_migration', 'raw_collected', '2026-11-08'); const raws = fs.readdirSync(rawDir).filter(x => x.startsWith(`${ven}_${rr}_`)).sort(); if (!raws.length) continue;
  const raw = JSON.parse(fs.readFileSync(path.join(rawDir, raws[raws.length - 1]), 'utf8'));
  const r = spawnSync('python', [path.join(__dirname, '..', 'scripts', 'wild', 'm_correct.py')], { input: JSON.stringify({ enginePct: CK.map(k => c.combos[k].enginePct), odds: CK.map(k => c.combos[k].odds), boats: raw.collected.preRaceInfo.boats }), encoding: 'utf8' });
  t(`実カード ${f}: Pythonが正常に補正した確率を返す(12点・合成・確率合計)`, () => { const j = JSON.parse(r.stdout); assert.ok(j.ok); assert.equal(j.lines.length, 12); assert.ok(j.gosei > 0 && j.p12 > 0); }); ran++;
}
if (ran >= 1) {   // エンジン確率が0.01%に丸められて0になる出目があっても、補正は有限の値を返す
  const dir2 = path.join(dir), f0 = fs.readdirSync(dir2)[0], c0 = JSON.parse(fs.readFileSync(path.join(dir2, f0), 'utf8')).card; const [v0, r0] = f0.slice(0, -5).split(/_(?=\d+R$)/);
  const rawDir0 = path.join(__dirname, '..', 'boatcast_migration', 'raw_collected', '2026-11-08'), rw = fs.readdirSync(rawDir0).filter(x => x.startsWith(`${v0}_${r0}_`)).sort();
  if (rw.length) { const raw0 = JSON.parse(fs.readFileSync(path.join(rawDir0, rw[rw.length - 1]), 'utf8')); const pct = CK.map(k => c0.combos[k].enginePct); const lowest = pct.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, 20); lowest.forEach(x => { pct[x[1]] = 0; });   // 確率の小さい出目を0にする(カードの丸めで起きる状態)
    const r = spawnSync('python', [path.join(__dirname, '..', 'scripts', 'wild', 'm_correct.py')], { input: JSON.stringify({ enginePct: pct, odds: CK.map(k => c0.combos[k].odds), boats: raw0.collected.preRaceInfo.boats }), encoding: 'utf8' });
    t('エンジン確率に0が混じっても補正は有限の値を返す', () => { const j = JSON.parse(r.stdout); assert.ok(j.ok && j.lines.length === 12); }); }
}
t('実カードの試験が1件以上走った', () => assert.ok(ran >= 1));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
