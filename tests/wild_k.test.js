'use strict';
// K(2026-11-13運用開始、CEO指示): 12点の確率計(AIおすすめ)>=0.40のレース。判定(wild_live)・画面(wild_template.html)・通知が同じ結果になること。
const assert = require('assert'), fs = require('fs'), path = require('path');
const W = require('../scripts/lib/wild_live');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ' + name); pass++; } catch (e) { console.log('FAIL ' + name + ': ' + e.message); fail++; } };
const mk = (pct) => ({ aiPick: { lines: Array.from({ length: 12 }, (_, i) => ({ combo: '1-2-' + (i + 3), enginePct: pct })) } });
t('kInfo: 12点の確率計が0.40以上でK、未満・12点未満・確率欠けは対象外', () => {
  assert.ok(W.kInfo(mk(3.4)) && Math.abs(W.kInfo(mk(3.4)).p12 - 0.408) < 1e-9);
  assert.strictEqual(W.kInfo(mk(3.3)), null);   // 0.396
  const c = mk(4); c.aiPick.lines.length = 11; assert.strictEqual(W.kInfo(c), null);
  const d = mk(4); d.aiPick.lines[0].enginePct = undefined; assert.strictEqual(W.kInfo(d), null);
  assert.strictEqual(W.K_P12_MIN, 0.40);
});
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'wild_template.html'), 'utf8');
const a = tplSrc.indexOf('function kOfCard'), b = tplSrc.indexOf('function rankTag');
const kOfCard = new Function(tplSrc.slice(a, b) + '; return kOfCard;')();
const days = fs.readdirSync(W.WILD_DIR).filter(f => /^index_\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(6, 16)).filter(d => d >= '2026-10-21').sort();
t('画面(wild_template.html)の kOfCard と、判定が全カードで一致', () => {
  let n = 0, k = 0;
  for (const d of days) { let fl = []; try { fl = fs.readdirSync(W.cardDir(d)); } catch (e) { continue; }
    for (const f of fl) { const c = W.readJson(path.join(W.cardDir(d), f), null); if (!c || !c.card) continue; n++;
      const x = W.kInfo(c.card), y = kOfCard(c.card); assert.strictEqual(!!x, !!y, f); if (x) { k++; assert.ok(Math.abs(x.p12 - y.p12) < 1e-9, f); } } }
  assert.ok(n > 500 && k > 50, 'n=' + n + ' k=' + k); console.log('   (カード' + n + '件、K ' + k + '件で一致)');
});
t('一覧の行(indexRow)にk・kP12が付く', () => {
  const d = days[days.length - 1]; const idx = W.readJson(W.indexFile(d), { races: [] });
  assert.ok(idx.races.length > 0); assert.ok('k' in idx.races[0] && 'kP12' in idx.races[0]);
});
t('通知: Kは【WILD K】・確信度・優先度4・キーはK_、S/A/B・M・Xと別、締切3分前を切ったら送らない', () => {
  const row = { k: true, kP12: 0.43, venue: '津', race: 5, date: '2026-11-13', deadline: '15:00', upset: 0.5, aiGosei: 3.1, top: { winner: 3, tech: 'まくり差し', scenarioPct: 21.2 } };
  const dl = W.deadlineMs('2026-11-13', '15:00') - 600000;
  const n = W.wildKNotificationFor(row, dl);
  assert.strictEqual(n.key, 'K_津_5'); assert.ok(n.title.startsWith('【WILD K】津5R'), n.title); assert.ok(n.body.includes('確信度43%'), n.body); assert.strictEqual(n.priority, 4);
  assert.strictEqual(W.wildKNotificationFor(Object.assign({}, row, { k: false }), dl), null);
  assert.strictEqual(W.wildKNotificationFor(row, W.deadlineMs('2026-11-13', '15:00') - 60000), null);
});
t('Kの前向きの仮想成績と稼働状況の項目がある', () => {
  const T = require('../scripts/lib/wild_tier_perf'); const r = T.computeKPerf(); assert.ok(r && r.all && r.from === T.K_FROM);
  const S = require('../scripts/lib/wild_status'); const st = S.computeWildStatus(Date.now(), {}); assert.ok('kNotified' in st && 'kCardsToday' in st && 'kPerf' in st);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
