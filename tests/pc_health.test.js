'use strict';
// PC健全性の警告ロジックの回帰テスト。実機には触れず、作り物のデータだけで確かめる。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pcHealthAlerts: A, notifySevere, SLEEP_BASELINE_MS } = require('../scripts/lib/pc_health');
const { toPublicStatus, buildEngineStatus } = require('../scripts/lib/engine_status');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log('  PASS: ' + name); pass++; } else { console.log('  FAIL: ' + name); fail++; } }
const now = SLEEP_BASELINE_MS + 5 * 3600000;   // 設定を直した時刻の5時間後
const iso = (ms) => new Date(ms).toISOString();
const base = () => ({ battery: { status: 2, percent: 100 }, sleepEvents: [], power: { standbyIdle: 0, unattendSleep: 0, videoIdle: 0, videoConLock: 0, hibernateIdle: 0 },
  taskRisk: { batteryStop: [], noCatchUp: [], disabled: [] }, sac: { blocks24h: 0, files: [] }, diskFreeGB: 800, engineProbe: { ok: true, failStreak: 0 } });
const ids = (h) => A(h, now).map(a => a.id);

check('全て正常なら、警告なし', A(base(), now).length === 0);
check('情報が取得できなければ warn(collect_failed)', ids({ missing: true }).includes('collect_failed'));
{ const h = base(); h.battery = { status: 1, percent: 100 };
  check('電源を外しているだけ(残量100%)は、info・スマホ通知の対象外', A(h, now).some(a => a.id === 'on_battery' && a.level === 'info' && !a.severe)); }
{ const h = base(); h.battery = { status: 1, percent: 49 };
  check('バッテリー駆動で残量50%未満は、warn+重大(スマホ通知の対象)', A(h, now).some(a => a.id === 'on_battery' && a.level === 'warn' && a.severe)); }
{ const h = base(); h.battery = { status: 1, percent: 50 };
  check('残量ちょうど50%は、まだ通知しない(境界)', A(h, now).some(a => a.id === 'on_battery' && !a.severe)); }
{ const h = base(); h.battery = { status: 1, percent: 20 };
  check('バッテリー駆動で残量30%未満はerror+重大', A(h, now).some(a => a.id === 'on_battery' && a.level === 'error' && a.severe)); }
{ const h = base(); h.sleepEvents = [{ at: iso(SLEEP_BASELINE_MS - 3600000), kind: 'sleep' }];
  check('設定を直す前のスリープは、数えない', !ids(h).includes('slept')); }
{ const h = base(); h.sleepEvents = [{ at: iso(now - 2 * 3600000), kind: 'sleep' }, { at: iso(now - 1 * 3600000), kind: 'wake' }];
  check('直したあとのスリープは、warn+重大', A(h, now).some(a => a.id === 'slept' && a.severe)); }
{ const h = base(); h.sleepEvents = [{ at: iso(now - 13 * 3600000), kind: 'sleep' }];
  check('12時間より前のスリープは、数えない', !ids(h).includes('slept')); }
for (const k of ['standbyIdle', 'unattendSleep', 'videoIdle', 'videoConLock', 'hibernateIdle']) {
  const h = base(); h.power[k] = 300;
  check(`電源設定 ${k} が0以外になったら、errorで検知`, A(h, now).some(a => a.id === 'power_drift' && a.level === 'error' && a.severe));
}
{ const h = base(); h.power.videoIdle = null; check('値が取れなかった設定(null)は、誤検知しない', !ids(h).includes('power_drift')); }
{ const h = base(); h.taskRisk = { batteryStop: ['GARON_X'], noCatchUp: ['GARON_X'], disabled: [] };
  const a = A(h, now).find(x => x.id === 'task_risk'); check('タスクの落とし穴を、名前つきで警告(重大ではない)', a && /GARON_X/.test(a.text) && !a.severe); }
{ const h = base(); h.sac = { blocks24h: 6, files: ['_qmvnt_cy.pyd'] }; check('SACのブロックを検知', A(h, now).some(a => a.id === 'sac_blocks' && /6件/.test(a.text))); }
{ const h = base(); h.engineProbe = { ok: false, failStreak: 1, sacSuspected: true };
  check('エンジンの部品の読み込み失敗1回は warn(重大でない)', A(h, now).some(a => a.id === 'engine_import' && a.level === 'warn' && !a.severe));
  h.engineProbe.failStreak = 2;
  check('2回連続はerror+重大', A(h, now).some(a => a.id === 'engine_import' && a.level === 'error' && a.severe)); }
{ const h = base(); h.diskFreeGB = 30; check('ディスクの空きが50GB未満でwarn', ids(h).includes('disk_low')); }
check('全ての警告は private(公開データに出さない)', (function () {
  const h = base(); h.battery.status = 1; h.battery.percent = 90; h.power.videoIdle = 60; h.sac = { blocks24h: 1, files: [] }; h.engineProbe = { ok: false, failStreak: 3 };
  return A(h, now).every(a => a.private === true);
})());

console.log('=== 通知の重複防止 ===');
(async () => {
  const stateFile = path.join(__dirname, '..', 'logs', '.pc_health_state.json'); const backup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  try { fs.unlinkSync(stateFile); } catch (e) { /* なし */ }
  const sent = []; const send = async (t, b) => { sent.push({ t, b }); };
  const h = base(); h.battery.status = 1; h.battery.percent = 40; const alerts = A(h, now);
  const r1 = await notifySevere(alerts, now, { send });
  check('最初は通知する', r1.sent === 1 && sent.length === 1);
  const r2 = await notifySevere(alerts, now + 3600000, { send });
  check('同じ異常を、1時間後には再通知しない', r2.sent === 0 && sent.length === 1);
  const r3 = await notifySevere(alerts, now + 7 * 3600000, { send });
  check('6時間を過ぎたら、再通知する', r3.sent === 1 && sent.length === 2);
  const r4 = await notifySevere(A(base(), now), now + 8 * 3600000, { send });
  check('異常がなければ、通知しない', r4.sent === 0);
  const noSend = await notifySevere(alerts, now + 20 * 3600000, { send: async () => { throw new Error('ntfy失敗'); } });
  check('通知に失敗しても、例外を出さない', noSend.sent === 0 && /ntfy失敗/.test(noSend.error));
  if (backup) fs.writeFileSync(stateFile, backup); else { try { fs.unlinkSync(stateFile); } catch (e) { /* なし */ } }

  console.log('=== 公開データに出さない ===');
  const st = buildEngineStatus({ nowMs: now, state: null, model: null, dbLastRaceDate: null, todayEvents: [], tasks: [], liveSummary: null, notificationsPaused: false, pcHealth: { ...base(), battery: { status: 1, percent: 40 } } });
  check('完全版には、PCの警告とpcHealthが入る', st.pcHealth && st.alerts.some(a => a.id === 'on_battery'));
  const pub = JSON.stringify(toPublicStatus(st));
  check('公開版には、pcHealth・PCの警告が入らない', !pub.includes('"pcHealth"') && !pub.includes('バッテリー駆動'));
  const old = buildEngineStatus({ nowMs: now, state: null, model: null, dbLastRaceDate: null, todayEvents: [], tasks: [], liveSummary: null, notificationsPaused: false });
  check('旧い呼び出し(pcHealth未指定)では、何も追加されない', old.pcHealth === null && !old.alerts.some(a => a.id));
  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`); process.exit(fail ? 1 : 0);
})();
