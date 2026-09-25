'use strict';
// ピーク枠 影運用の、稼働状況(非公開)への表示・警告の回帰テスト。
const { summarizePeakSlot: S, peakSlotAlerts: A } = require('../scripts/lib/peak_slot_status');
const { toPublicStatus, buildEngineStatus } = require('../scripts/lib/engine_status');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log('  PASS: ' + name); pass++; } else { console.log('  FAIL: ' + name); fail++; } }
const now = Date.parse('2026-10-06T12:00:00+09:00');
const ago = (m) => new Date(now - m * 60000).toISOString();
const alerts = (hb, st, sd, at = now) => A(S(hb, st, at, sd), at);
const okSt = (over) => ({ updatedAt: ago(600), chain: { ok: true }, missRate: 0.01, dayIndex: 3, durationDays: 14, ...over });

check('開始前(startDate無し・ハートビートあり)は警告しない', alerts({ state: 'not_started', at: ago(1) }, null, null).length === 0);
check('開始前で何も無ければ、要約自体が無い(null)', S(null, null, now, null) === null);
check('記録係が正常なら警告なし', alerts({ state: 'ok', at: ago(2), totalToday: 30, adoptedToday: 3 }, okSt(), '2026-10-04').length === 0);
check('稼働時間内に記録係が15分以上止まるとerror', alerts({ state: 'ok', at: ago(20) }, okSt(), '2026-10-04').some(a => a.level === 'error' && /記録係/.test(a.text)));
check('14分なら警告しない(境界)', alerts({ state: 'ok', at: ago(14) }, okSt(), '2026-10-04').length === 0);
check('開始日後にハートビートが一度も無ければerror(タスク未登録)', alerts(null, null, '2026-10-04').some(a => a.level === 'error' && /登録/.test(a.text)));
check('開始日より前は、ハートビートが無くても警告しない', alerts(null, null, '2026-10-20').length === 0);
check('台帳の連鎖が壊れているとerror', alerts({ state: 'ok', at: ago(1) }, okSt({ chain: { ok: false, where: '2026-10-05 行3', error: 'x' } }), '2026-10-04').some(a => a.level === 'error' && /連鎖/.test(a.text)));
check('夜間の照合が30時間以上動いていなければwarn', alerts({ state: 'ok', at: ago(1) }, okSt({ updatedAt: ago(2900) }), '2026-10-04').some(a => a.level === 'warn' && /照合/.test(a.text)));
check('取りこぼし率が5%を超えるとwarn', alerts({ state: 'ok', at: ago(1) }, okSt({ missRate: 0.08 }), '2026-10-04').some(a => a.level === 'warn' && /取りこぼし/.test(a.text)));
check('稼働時間外(夜間)は、ハートビートが古くても警告しない', (function () {
  const night = Date.parse('2026-10-06T23:00:00+09:00');
  return A(S({ state: 'ok', at: new Date(night - 300 * 60000).toISOString() }, { updatedAt: new Date(night - 600 * 60000).toISOString(), chain: { ok: true }, missRate: 0 }, night, '2026-10-04'), night).length === 0;
})());
check('停止スイッチはinfo', alerts({ state: 'stopped', at: ago(1) }, null, '2026-10-04').every(a => a.level === 'info'));
check('全ての警告は private(公開データに出さない目印)', alerts({ state: 'ok', at: ago(20) }, okSt({ chain: { ok: false, where: 'x', error: 'y' }, missRate: 0.08, updatedAt: ago(2900) }), '2026-10-04').every(a => a.private === true));

console.log('=== 公開データに個人情報を出さない ===');
{
  const st = buildEngineStatus({ nowMs: now, state: null, model: null, dbLastRaceDate: null, todayEvents: [], tasks: [], liveSummary: null, notificationsPaused: false,
    peakSlotRaw: { hb: { state: 'ok', at: ago(20) }, st: okSt(), startDate: '2026-10-04' } });
  check('完全版(PC内)には、peakSlotと警告が入る', st.peakSlot && st.alerts.some(a => a.private && /記録係/.test(a.text)));
  const pub = JSON.stringify(toPublicStatus(st));
  check('公開版には、peakSlot・ピーク枠の警告が入らない', !pub.includes('"peakSlot"') && !pub.includes('ピーク枠'));
  const old = buildEngineStatus({ nowMs: now, state: null, model: null, dbLastRaceDate: null, todayEvents: [], tasks: [], liveSummary: null, notificationsPaused: false });
  check('旧い呼び出し(peakSlotRaw未指定)では、何も追加されない', old.peakSlot === null && !old.alerts.some(a => /ピーク枠/.test(a.text)));
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
