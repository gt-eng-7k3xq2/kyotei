'use strict';
// 目安M(Mid=中配当、2026-10-21 CEO決定)。規則(wild_live.mInfo)・通知・画面(wild_template.html の mOfCard)が同じ結果になること。
const assert = require('assert'), fs = require('fs'), path = require('path');
const W = require('../scripts/lib/wild_live');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ' + name); pass++; } catch (e) { console.log('FAIL ' + name + ': ' + e.message); fail++; } };
// 12点: 各点のオッズ odds・確率 pct(合成オッズ=1/Σ(1/odds)、p12=Σpct/100)
const mk = (upset, odds, pct, rank) => ({ overview: { upset }, entry: rank ? { rank } : {}, aiPick: { lines: Array.from({ length: 12 }, (_, i) => ({ combo: '2-3-' + (i + 1), odds, enginePct: pct })) } });
const g = (odds) => 1 / (12 / odds);   // 12点が同じオッズ→合成=odds/12
t('条件を満たすと M(荒れ50%・合成4.5倍=オッズ54・p12 18%)', () => { const c = mk(0.5, 54, 1.5); assert.ok(W.mInfo(c)); assert.ok(Math.abs(W.mInfo(c).gosei - 4.5) < 1e-9); assert.ok(Math.abs(W.mInfo(c).p12 - 0.18) < 1e-9); });
t('荒れ40%ちょうどは対象外(40%超)', () => assert.strictEqual(W.mInfo(mk(0.40, 54, 1.5)), null));
t('合成3.5倍ちょうどは対象(以上)、3.49倍は対象外', () => { assert.ok(W.mInfo(mk(0.5, 42, 1.5))); assert.strictEqual(W.mInfo(mk(0.5, 41.8, 1.5)), null); });
t('合成6倍以上は対象外(未満)', () => assert.strictEqual(W.mInfo(mk(0.5, 73, 1.5)), null));
t('p12 15%未満は対象外', () => assert.strictEqual(W.mInfo(mk(0.5, 54, 1.2)), null));
t('ランクS/A/Bのレースは対象外(重複通知を防ぐ)', () => assert.strictEqual(W.mInfo(mk(0.5, 54, 1.5, 'B')), null));
t('12点に満たないカードは対象外', () => { const c = mk(0.5, 54, 1.5); c.aiPick.lines.length = 11; assert.strictEqual(W.mInfo(c), null); });
t('通知の文言はランクS/A/Bと同じ形(タイトル【WILD ○】、本文=荒れやすさ・一番ありそうな展開・あと約N分)', () => {
  const dl = W.deadlineMs('2026-10-21', '15:00'), base = { venue: '津', race: 5, date: '2026-10-21', deadline: '15:00', upset: 0.5, top: { winner: 3, tech: 'まくり差し', scenarioPct: 21.2 } };
  const b = W.wildNotificationFor(Object.assign({ rank: 'B' }, base), dl - 600000);
  const x = W.wildXNotificationFor(Object.assign({ x: true, xLines: W.mInfo(mk(0.5, 54, 1.5)).lines }, base), dl - 600000);
  const m = W.wildMNotificationFor(Object.assign({ m: true, mLines: W.mInfo(mk(0.5, 54, 1.5)).lines, mGosei: 4.5 }, base), dl - 600000);
  const shape = (n) => n.body.replace(/\d+/g, '#');
  assert.strictEqual(shape(x), shape(b)); assert.strictEqual(shape(m), shape(b));
  assert.strictEqual(x.title.replace('WILD X', 'WILD ?'), b.title.replace('WILD B', 'WILD ?').replace('WILD ?', 'WILD ?')); 
});
t('通知: 締切3分前を切ると送らない(1日の上限は無し)', () => {
  const row = { m: true, mLines: W.mInfo(mk(0.5, 54, 1.5)).lines, venue: '津', race: 5, date: '2026-10-21', deadline: '15:00', upset: 0.5, mGosei: 4.5, top: { winner: 3, tech: 'まくり差し', scenarioPct: 21.2 } };
  const n = W.wildMNotificationFor(row, W.deadlineMs('2026-10-21', '15:00') - 600000); assert.ok(n && n.key === 'M_津_5' && n.title.startsWith('【WILD M】津5R') && n.priority === 3 && n.body.startsWith('荒れやすさ 50%。一番ありそうな展開:') && n.body.includes('タップでGARON-WILDを開きます。'));
  assert.strictEqual(W.wildMNotificationFor(row, W.deadlineMs('2026-10-21', '15:00') - 120000), null); assert.strictEqual(W.M_DAILY_CAP, undefined); assert.strictEqual(W.X_DAILY_CAP, undefined);
});
t('画面(wild_template.html の mOfCard)と同じ判定(実カード全件で一致)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'wild_template.html'), 'utf8');
  const a = src.indexOf('const M_UPSET_MIN'), b = src.indexOf('function rankTag');
  const mOfCard = new Function(src.slice(a, b) + '; return mOfCard;')();
  let n = 0, hit = 0; const D = ['2026-10-19', '2026-10-20', '2026-10-21'];
  for (const d of D) { let files = []; try { files = fs.readdirSync(W.cardDir(d)); } catch (e) { continue; }
    for (const f of files) { const c = W.readJson(path.join(W.cardDir(d), f), null); if (!c || !c.card) continue; n++; const x = W.mInfo(c.card), y = mOfCard(c.card); if (x) hit++; assert.strictEqual(!!x, !!y, d + ' ' + f); if (x) assert.ok(Math.abs(x.gosei - y.gosei) < 0.01); } }
  assert.ok(n > 100, 'カードが少なすぎる: ' + n); console.log('   (カード' + n + '件、M該当' + hit + '件で一致)');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
