'use strict';
// 通知X(2026-10-19): 通知の買い目(card.aiPick.xLines)と、WILD画面のおまかせ案(通知Xのレースでは xmode)が同じ12点になること。通常(xmode=false)は1号艇頭なしの12点のままであること。
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'garon_wild.html'), 'utf8');
const g = re => { const m = html.match(re); if (!m) throw new Error('抽出失敗 ' + re); return m[0]; };
const code = [g(/const PLAN_POINTS[^\n]*\n/), g(/const X_ODDS_MIN[^\n]*\n/), g(/const PLAN_MIN_POINTS[\s\S]*?function variableK[\s\S]*?return n;\s*\}/), g(/function hasExcluded[^\n]*\n/), g(/function autoPlan[\s\S]*?\n\}\r?\n/), g(/function mergeBlocks[\s\S]*?return out;\s*\}/), g(/const SAMPLES = [^\n]*\n/)].join('\n');
const F = new Function(code + ';let S=null;return {autoPlan,mergeBlocks,SAMPLES,setS:v=>{S=v;}};')();
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + e.message.split('\n')[0]); } };
F.SAMPLES.forEach(s => {
  const info = s.card.combos, xs = Object.keys(info).filter(c => info[c].odds >= 80).sort((a, b) => info[b].enginePct - info[a].enginePct).slice(0, 12);
  s.card.aiPick = Object.assign({}, s.card.aiPick, { xLines: xs.map(c => ({ combo: c, odds: info[c].odds, enginePct: info[c].enginePct })) });
  t(`${s.venue}${s.race}R: 通知Xのレースでは、画面の買い目=通知の12点`, () => { F.setS({ xmode: true }); const cs = F.mergeBlocks(F.autoPlan(s.card, null, []).blocks); assert.equal(cs.length, 12); assert.deepEqual(cs.slice().sort(), xs.slice().sort()); });
  t(`${s.venue}${s.race}R: 通常は1号艇頭なしの12点(従来どおり)`, () => { F.setS({ xmode: false }); const cs = F.mergeBlocks(F.autoPlan(s.card, null, []).blocks); assert.equal(cs.length, 12); assert.ok(cs.every(c => !c.startsWith('1-'))); });
  t(`${s.venue}${s.race}R: 艇を消すと、その艇を含まない12点になる(足りない分は80倍以上で埋める)`, () => { F.setS({ xmode: true }); const cs = F.mergeBlocks(F.autoPlan(s.card, null, [2]).blocks); assert.ok(cs.every(c => !c.split('-').includes('2')) && cs.length <= 12); });
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
