'use strict';
// Grok Bot向け公開JSON(scripts/publish_grok_status.js): 項目が必要なものだけ・K/M(edge)だけ・接続情報や内部情報を含まない
const assert = require('assert');
const { buildPublicJson, sig } = require('../scripts/publish_grok_status');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + e.message.split('\n')[0]); } };
const now = Date.UTC(2026, 10, 26, 3, 0, 0);
const mk = (o) => Object.assign({ venue: '唐津', race: 7, deadline: '12:00', tier: 'K', edge: false, result: { state: 'hit', mult: 7.8, win: '1-2-3', yen: 780 }, lines: [{ c: '1-2-3', o: 7.8 }], my: { stake: 1200, lines: [] }, gosei: 4.2, upset: 0.6 }, o);
const st = { date: '2026-11-26', entryRaces: [mk({ venue: '江戸川', race: 2, tier: 'M', edge: true, result: { state: 'miss', win: '2-1-4' } }), mk({ tier: 'S' }), mk({ venue: '桐生', race: 3, tier: 'M', edge: false }), mk({}), mk({ venue: '津', race: 5, tier: 'K', result: { state: 'pending' } }), mk({ venue: '津', race: 5, tier: 'K', result: { state: 'pending' } }), mk({ venue: '住之江', race: 9, tier: 'X' })] };
const j = buildPublicJson(now, st);
t('記録対象はKとM(edge)だけ(S・Mのedgeなし・Xは出ない)・重複なし・締切の早い順(入力は新しい順)', () => { assert.deepEqual(j.races.map(r => r.venue + r.race + r.type), ['津5K', '唐津7K', '江戸川2M(edge)']); });
t('的中は倍率、不的中・結果待ちはnull', () => { assert.deepEqual(j.races.map(r => [r.result, r.payoutMultiple]), [['pending', null], ['hit', 7.8], ['miss', null]]); });
t('集計', () => { assert.deepEqual(j.summary, { count: 3, hits: 1, misses: 1, pending: 1 }); });
t('更新時刻はJST(+09:00)で入る', () => { assert.equal(j.updatedAtJst, '2026-11-26T12:00:00+09:00'); });
t('項目は必要なものだけ(買い目・配分・合成・確率・個人の記録・接続情報なし)', () => {
  assert.deepEqual(Object.keys(j), ['date', 'updatedAtJst', 'races', 'summary']); j.races.forEach(r => assert.deepEqual(Object.keys(r), ['venue', 'race', 'type', 'result', 'payoutMultiple']));
  const s = JSON.stringify(j); ['lines', 'stake', 'gosei', 'upset', 'my', 'ts.net', 'token', 'ghp_', 'github_pat', 'AI', 'エンジン'].forEach(w => assert.ok(!s.includes(w), w));
});
t('内容の署名は更新時刻に左右されない', () => { assert.equal(sig(j), sig(Object.assign({}, j, { updatedAtJst: 'x' }))); });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
