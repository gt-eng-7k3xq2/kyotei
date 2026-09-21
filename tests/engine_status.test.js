'use strict';
const assert = require('assert'); const S = require('../scripts/lib/engine_status');
let p = 0, f = 0; const t = (n, fn) => { try { fn(); p++; console.log('PASS  ' + n); } catch (e) { f++; console.log('FAIL  ' + n + ': ' + e.message); } };
const now = Date.parse('2026-09-21T03:00:00Z'); // JST 12:00
const ev = (eventType, x = {}) => ({ eventType, loggedAt: '2026-09-21T02:55:00Z', ...x });
const tasks = [{ Name: 'GARON_RealtimeScreeningBoatcast', State: 'Running' }];
const base = { nowMs: now, state: { lastDay: '2026-09-20' }, model: { trainedThrough: '2026-09-20' }, dbLastRaceDate: '2026-09-20', tasks, liveSummary: null, notificationsPaused: false };
t('件数の集計(高・中上・失敗)', () => {
  const s = S.summarizeToday([ev('engine_judgment', { top1p: 0.12 }), ev('engine_judgment', { top1p: 0.09 }), ev('engine_judgment', { top1p: 0.05 }), ev('collection_failed', { venue: '三国' }), ev('bm_generated'), ev('engine_notification_sent')], '2026-09-21');
  assert.deepEqual([s.judgments, s.high, s.mid_high, s.collectionFailed, s.collected, s.notificationsSent], [3, 1, 1, 1, 1, 1]);
});
t('正常時は警告なし', () => assert.equal(S.buildEngineStatus({ ...base, todayEvents: [ev('bm_generated')] }).overall, 'ok'));
t('状態が3日以上古いとerror', () => assert.equal(S.buildEngineStatus({ ...base, state: { lastDay: '2026-09-17' }, todayEvents: [ev('bm_generated')] }).overall, 'error'));
t('DBが状態より新しいとwarn', () => { const r = S.buildEngineStatus({ ...base, dbLastRaceDate: '2026-09-21', todayEvents: [ev('bm_generated')] }); assert.ok(r.alerts.some(a => /update_state/.test(a.text))); });
t('稼働時間帯に記録が20分途絶えるとwarn', () => { const r = S.buildEngineStatus({ ...base, todayEvents: [{ eventType: 'bm_generated', loggedAt: '2026-09-21T02:00:00Z' }] }); assert.ok(r.alerts.some(a => /止まっている/.test(a.text))); });
t('夜間は記録が無くても警告しない', () => { const r = S.buildEngineStatus({ ...base, nowMs: Date.parse('2026-09-21T14:00:00Z'), state: { lastDay: '2026-09-21' }, model: { trainedThrough: '2026-09-21' }, dbLastRaceDate: '2026-09-21', todayEvents: [] }); assert.equal(r.overall, 'ok'); });
t('通知送信失敗はerror', () => assert.equal(S.buildEngineStatus({ ...base, todayEvents: [ev('engine_notification_failed')] }).overall, 'error'));
t('タスク無効はerror', () => assert.equal(S.buildEngineStatus({ ...base, tasks: [{ Name: 'GARON_RealtimeScreeningBoatcast', State: 'Disabled' }], todayEvents: [ev('bm_generated')] }).overall, 'error'));
t('収集失敗が3割超でwarn', () => { const e = [...Array(6).fill(0).map(() => ev('collection_failed', { venue: 'A' })), ...Array(6).fill(0).map(() => ev('bm_generated'))]; assert.ok(S.buildEngineStatus({ ...base, todayEvents: e }).alerts.some(a => /収集の失敗/.test(a.text))); });
t('実運用「高」が検証時より大きく下回るとwarn', () => { const live = { live: { byLevel: { 高: { n: 40, hit10: 0.4, baseline: { hit10: 0.659 } } } } }; assert.ok(S.buildEngineStatus({ ...base, liveSummary: live, todayEvents: [ev('bm_generated')] }).alerts.some(a => /実運用/.test(a.text))); });
t('通知一時停止はinfo(overallに影響しない)', () => { const r = S.buildEngineStatus({ ...base, notificationsPaused: true, todayEvents: [ev('bm_generated')] }); assert.equal(r.overall, 'ok'); assert.equal(r.alerts[0].level, 'info'); });
t('振り分け: 公式の日程を土台に、通知・見送り(理由別)・取得失敗・評価なし・これから を全レース分出す', () => {
  const nowMs = Date.parse('2026-09-21T06:00:00Z'); // JST 15:00
  const sched = [{ venue: '桐生', raceNumber: 1, deadline: '10:00' }, { venue: '桐生', raceNumber: 2, deadline: '11:00' }, { venue: '桐生', raceNumber: 3, deadline: '12:00' }, { venue: '桐生', raceNumber: 4, deadline: '13:00' }, { venue: '桐生', raceNumber: 5, deadline: '14:00' }, { venue: '桐生', raceNumber: 6, deadline: '20:00' }];
  const e = (eventType, n, x = {}) => ({ eventType, venue: '桐生', raceNumber: n, loggedAt: '2026-09-21T04:00:00Z', ...x });
  const ev = [e('engine_judgment', 1, { top1p: 0.13, bets: ['1-2-3'], gosei: 3, skip: false }), e('engine_notification_sent', 1), e('engine_judgment', 2, { top1p: 0.12, skip: true, gosei: 1.6 }), e('engine_judgment', 3, { top1p: 0.05 }), e('collection_failed', 4), e('feature_incomplete', 4)];
  const d = S.buildDispositions(ev, {}, sched, nowMs); const kind = n => d.rows.find(r => r.race === n).kind;
  assert.equal(d.rows.length, 6);
  assert.deepEqual([kind(1), kind(2), kind(3), kind(4), kind(5), kind(6)], ['notify', 'skip_odds', 'skip_conf', 'no_data', 'missed', 'pending']);
  assert.equal(d.counts.notify, 1); assert.equal(d.counts.pending, 1);
});
t('振り分け: 同じレースにエンジンの予測があれば、旧モデルの特徴不足より優先する', () => {
  const ev = [{ eventType: 'engine_judgment', venue: '丸亀', raceNumber: 5, top1p: 0.07, loggedAt: '2026-09-21T04:00:00Z' }, { eventType: 'feature_incomplete', venue: '丸亀', raceNumber: 5, loggedAt: '2026-09-21T04:05:00Z', reason: 'x' }];
  const d = S.buildDispositions(ev, {}, [], Date.now()); assert.equal(d.rows.length, 1); assert.equal(d.rows[0].kind, 'skip_conf');
});
t('止まっている疑い: 最終レースの後(評価すべきレースが無い時間)は警告しない。レースがあるのに記録が無ければ警告する', () => {
  const sched = [{ venue: '桐生', raceNumber: 12, deadline: '20:45' }];
  const base2 = { ...base, todayEvents: [{ eventType: 'bm_generated', loggedAt: '2026-09-21T11:00:00Z' }], schedule: sched };
  const late = S.buildEngineStatus({ ...base2, nowMs: Date.parse('2026-09-21T12:11:00Z') });   // JST 21:11、最終レース(20:45)の後
  assert.ok(!late.alerts.some(a => /止まっている/.test(a.text)));
  const during = S.buildEngineStatus({ ...base2, nowMs: Date.parse('2026-09-21T11:30:00Z') });   // JST 20:30、締切の15分前
  assert.ok(during.alerts.some(a => /止まっている/.test(a.text)));
});
t('警告の原因の切り分け: データバンクが止まっているなら、Codex側の更新が必要と案内する', () => {
  const r = S.buildEngineStatus({ ...base, nowMs: Date.parse('2026-09-21T03:00:00Z'), state: { lastDay: '2026-09-18' }, dbLastRaceDate: '2026-09-18', todayEvents: [ev('bm_generated')] });
  assert.ok(r.alerts.some(a => /Codex/.test(a.text)));
});
console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
