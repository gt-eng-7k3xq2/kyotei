'use strict';
// GARON_RaceOpsServerのヘルスチェック判断ロジック(scripts/lib/race_ops_healthcheck_core.js)の検査。
// 実行: node tests/race_ops_healthcheck.test.js
const assert = require('assert');
const C = require('../scripts/lib/race_ops_healthcheck_core');
let p = 0, f = 0; const t = (n, fn) => { try { fn(); p++; console.log('PASS  ' + n); } catch (e) { f++; console.log('FAIL  ' + n + ': ' + e.message); } };
const now = Date.parse('2026-09-23T12:00:00Z');
const isoBefore = (sec) => new Date(now - sec * 1000).toISOString();

t('正常応答のときは何もしない', () => {
  const r = C.decide({ healthy: true, state: { restarts: [] }, nowMs: now });
  assert.equal(r.action, 'none');
});
t('応答なしで、直近に再起動していなければ再起動する', () => {
  const r = C.decide({ healthy: false, state: { restarts: [] }, nowMs: now });
  assert.equal(r.action, 'restart');
});
t('応答なしでも、直前の再起動から2分未満なら様子を見る(すぐ再起動しない)', () => {
  const r = C.decide({ healthy: false, state: { restarts: [isoBefore(60)] }, nowMs: now });
  assert.equal(r.action, 'none');
});
t('直前の再起動から2分以上たてば、再度応答なしなら再起動する', () => {
  const r = C.decide({ healthy: false, state: { restarts: [isoBefore(130)] }, nowMs: now });
  assert.equal(r.action, 'restart');
});
t('1時間以内の再起動が上限(5回)に達したら、それ以上は再起動せず警告だけにする(無限ループ防止)', () => {
  const restarts = [isoBefore(3000), isoBefore(2400), isoBefore(1800), isoBefore(1200), isoBefore(600)];
  const r = C.decide({ healthy: false, state: { restarts }, nowMs: now });
  assert.equal(r.action, 'alert_only');
});
t('1時間より古い再起動は数えない(時間がたてば自動再起動が復活する)', () => {
  const restarts = [isoBefore(4000), isoBefore(3900), isoBefore(3800), isoBefore(3700), isoBefore(3650)]; // 全て1時間超前
  const r = C.decide({ healthy: false, state: { restarts }, nowMs: now });
  assert.equal(r.action, 'restart'); assert.equal(r.restarts.length, 0);
});
console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
