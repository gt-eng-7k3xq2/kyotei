'use strict';
// GARON-WILD の稼働状況(稼働状況ページ向け)の試験(2026-09-26)。一時フォルダだけに書く。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wildstatus-'));
process.env.GARON_WILD_DIR = path.join(tmp, 'wild');
const W = require('../scripts/lib/wild_live');
const { computeWildStatus, mergeWild, annotateDispositions } = require('../scripts/lib/wild_status');
const { toPublicStatus } = require('../scripts/lib/engine_status');

let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + e.message.split('\n')[0]); } };
const date = '2026-09-26';
const at = (hhmm) => W.deadlineMs(date, hhmm);   // 指定した JST 時刻(ミリ秒)
const card = (venue, race, deadline, tier, ok = true) => W.writeJsonAtomic(W.cardFile(date, venue, race), ok ? { ok: true, venue, race, deadline, card: { overview: { upset: 0.7 }, scenarios: [{ winner: 2, tech: '差し', scenarioPct: 15 }], entry: { tier } } } : { ok: false, error: 'x' });
card('丸亀', 3, '13:00', 'strong'); card('多摩川', 3, '13:10', 'a'); card('津', 6, '13:20', 'none'); card('尼崎', 2, '12:00', 'a');
const rowsOf = () => ['丸亀', '多摩川', '津', '尼崎'].map(v => { const c = W.readJson(W.cardFile(date, v, { 丸亀: 3, 多摩川: 3, 津: 6, 尼崎: 2 }[v]), null); return W.indexRow({ venue: c.venue, race: c.race, deadline: c.deadline, card: c.card, capturedAt: 'x' }); });
const writeIndex = (iso) => W.writeJsonAtomic(W.indexFile(date), { date, generatedAt: iso, races: rowsOf() });
const NOW = at('12:30');

t('正常: 裏方が動いていて、カード・目安・状態が出る', () => {
  writeIndex(new Date(NOW - 30000).toISOString());
  W.writeJsonAtomic(W.notifiedFile(date), { '丸亀_3': { at: 'x' } });
  const w = computeWildStatus(NOW);
  assert.equal(w.inHours, true); assert.ok(w.indexAgeMin <= 1);
  assert.deepEqual(w.cards.byTier, { strong: 1, a: 2, none: 1 }); assert.equal(w.cards.total, 4); assert.equal(w.cards.failed, 0);
  const st = Object.fromEntries(w.entryRaces.map(r => [r.venue + r.race, r.state]));
  assert.equal(st['丸亀3'], 'notified'); assert.equal(st['多摩川3'], 'new'); assert.equal(st['尼崎2'], 'closed');   // 尼崎は12:00締切→締切済み
  assert.equal(w.notifiedCount, 1); assert.deepEqual(w.alerts, []);
  assert.ok(!('津3' in st) && !('津6' in st), '対象外は一覧に出さない');
});
t('記録・見送り・結果待ちの件数と、レースごとの状態(購入/見送り)', () => {
  const base = { mode: 'live', raceDate: date, deadline: '13:00', entryTier: 'strong', receivedAt: new Date(NOW).toISOString() };
  W.appendLedger(Object.assign({}, base, { action: 'bet', venue: '丸亀', raceNo: 3, race: '丸亀3R', lines: [{ combo: '2-1-3', amount: 3000, odds: 30 }], total: 3000, pointCount: 1 }));
  W.appendLedger(Object.assign({}, base, { action: 'pass', venue: '多摩川', raceNo: 3, race: '多摩川3R' }));
  const w = computeWildStatus(NOW);
  assert.equal(w.ledger.todayBets, 1); assert.equal(w.ledger.todayPasses, 1); assert.equal(w.ledger.waitingResults, 1);
  const st = Object.fromEntries(w.entryRaces.map(r => [r.venue + r.race, r.state])); assert.equal(st['丸亀3'], 'bet'); assert.equal(st['多摩川3'], 'pass');
  W.writeJsonAtomic(W.resultsFile(date), { '丸亀_3': { kind: 'confirmed', chakuju: '2-1-3', payout: '¥3,000' } });
  const w2 = computeWildStatus(NOW); assert.equal(w2.ledger.waitingResults, 0); assert.equal(w2.results.confirmed, 1);
  assert.ok(!JSON.stringify(w2).includes('2-1-3'), '買い目・結果の中身は含めない');
});
t('裏方が止まる(稼働時間帯に索引が5分以上更新されない)と、errorの警告。overallもerror', () => {
  writeIndex(new Date(NOW - 8 * 60000).toISOString());
  const w = computeWildStatus(NOW); assert.ok(w.indexAgeMin >= 8); assert.equal(w.alerts.length, 1); assert.equal(w.alerts[0].level, 'error'); assert.ok(w.alerts[0].text.startsWith('WILD'));
  const m = mergeWild({ alerts: [{ level: 'warn', text: '別の警告' }], overall: 'warn' }, w); assert.equal(m.overall, 'error'); assert.equal(m.alerts.length, 2);
});
t('稼働時間外(22時以降)は、止まっていても警告しない', () => {
  writeIndex(new Date(at('21:50')).toISOString());
  const w = computeWildStatus(at('23:00')); assert.equal(w.inHours, false); assert.deepEqual(w.alerts, []);
});
t('mergeWild: 古いWILDの警告は入れ替え、ほかの警告は残す。overallを再計算', () => {
  const old = { alerts: [{ level: 'error', text: 'WILDの裏方の更新が9分間ありません' }, { level: 'warn', text: 'データバンクが遅れています' }], overall: 'error' };
  const m = mergeWild(old, { alerts: [] }); assert.deepEqual(m.alerts.map(a => a.text), ['データバンクが遅れています']); assert.equal(m.overall, 'warn');
  assert.equal(mergeWild({ alerts: [], overall: 'ok' }, { alerts: [] }).overall, 'ok');
});
t('カード作成の失敗は警告。台帳の検証は行わない(改ざんの警告は出ない)', () => {
  writeIndex(new Date(NOW - 20000).toISOString()); card('津', 6, '13:20', 'none', false);
  let w = computeWildStatus(NOW); assert.equal(w.cards.failed, 1); assert.ok(w.alerts.some(a => a.level === 'warn' && /カードを作れなかった/.test(a.text)));
  const f = W.ledgerFile(), orig = fs.readFileSync(f, 'utf8'); const ls = orig.split('\n').filter(Boolean); const e = JSON.parse(ls[0]); e.total = 1; ls[0] = JSON.stringify(e); fs.writeFileSync(f, ls.join('\n') + '\n');
  w = computeWildStatus(NOW); assert.ok(!('verifyOk' in w.ledger)); assert.ok(!w.alerts.some(a => /台帳/.test(a.text)));
  fs.writeFileSync(f, orig);
});
t('振り分け一覧への合流: 目安に印、WILD購入は「あなたの参入」に加える(gtoolの記録と重複しない)。公開用では取り除く', () => {
  const disp = { counts: {}, rows: [
    { venue: '丸亀', race: 3, kind: 'notify' }, { venue: '多摩川', race: 3, kind: 'skip_conf' }, { venue: '津', race: 6, kind: 'skip_conf' }, { venue: '尼崎', race: 2, kind: 'skip_conf', mine: 'miss' }, { venue: '桐生', race: 1, kind: 'skip_conf' }],
    mine: { total: 1, hit: 0, miss: 1, open: 0, overlapNotify: 0, mineOnly: 1, engineOnly: 1 } };
  const wild = { entryRaces: [{ venue: '丸亀', race: 3, tier: 'strong', state: 'bet' }, { venue: '多摩川', race: 3, tier: 'a', state: 'pass' }, { venue: '尼崎', race: 2, tier: 'a', state: 'bet' }],
    bets: [{ venue: '丸亀', race: 3, state: 'hit' }, { venue: '尼崎', race: 2, state: 'miss' }, { venue: '桐生', race: 1, state: 'open' }] };
  const d = annotateDispositions(disp, wild); const by = Object.fromEntries(d.rows.map(r => [r.venue + r.race, r]));
  assert.deepEqual(by['丸亀3'].wild, { tier: 'strong', state: 'bet' }); assert.equal(by['丸亀3'].mine, 'hit'); assert.equal(by['丸亀3'].wildBet, 'hit');
  assert.equal(by['多摩川3'].wild.state, 'pass'); assert.ok(!by['多摩川3'].mine);                       // 見送りは「参入」に入れない
  assert.equal(by['尼崎2'].mine, 'miss');                                                                // gtoolの記録が既にある: そのまま(重複して数えない)
  assert.equal(by['桐生1'].mine, 'open'); assert.ok(!by['桐生1'].wild);                                 // 目安の対象外でも、購入したら参入に入る
  assert.ok(!('wild' in by['津6']));
  assert.deepEqual([d.mine.total, d.mine.hit, d.mine.miss, d.mine.open], [3, 1, 1, 1]);                  // gtool1 + WILD(丸亀3・桐生1)
  assert.equal(d.mine.overlapNotify, 1); assert.equal(d.wild.bets, 3); assert.equal(d.wild.marked, 3);
  const pub = toPublicStatus({ overall: 'ok', alerts: [], dispositions: d }); assert.ok(pub.dispositions.rows.every(r => !('wild' in r) && !('wildBet' in r) && !('mine' in r)) && !('mine' in pub.dispositions) && !('wild' in pub.dispositions));
  assert.strictEqual(annotateDispositions(null, wild), null); assert.deepEqual(annotateDispositions(disp, null), disp);
});
t('公開用の稼働状況からは、wildを取り除く(記録の件数・状態は非公開)', () => {
  const pub = toPublicStatus({ overall: 'ok', alerts: [], wild: { ledger: { todayBets: 3 } }, practice: { x: 1 }, dispositions: { counts: {}, rows: [] } });
  assert.ok(!('wild' in pub) && !('practice' in pub));
});
t('logs/wild の実物には書き込んでいない', () => { assert.ok(W.WILD_DIR.startsWith(tmp)); });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
