'use strict';
// 2026-09-15新設(受入監査指摘8「日付処理をJSTで固定する」):
// scripts/lib/jst_time.js・scripts/lib/race_ops_result_fetch.js の日付/時刻計算が、プロセスの
// TZ環境変数(OSのタイムゾーン設定)に依存せず常にJST基準で正しく動くことを、実際に異なる
// TZ環境変数を設定した子プロセスを起動して検証する(単に同じプロセス内でDateを呼ぶだけでは、
// このPC自体がJST設定であるため「たまたま正しい」だけの検証になってしまうため)。
//
// 使い方: node tests/race_ops_jst_time.regression.test.js

const { execFileSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const ROOT = path.join(__dirname, '..');

function runInChildWithTZ(tz, code) {
  return execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { TZ: tz }),
  }).trim();
}

console.log('=== テスト1: todayDateStrJSTはTZ環境変数を変えても同じ結果になる(UTCエポック基準で固定計算しているため) ===');
{
  const fixedNowMs = Date.UTC(2026, 8, 14, 16, 30, 0); // UTC 2026-09-14 16:30 = JST 2026-09-15 01:30
  const code = `const {todayDateStrJST}=require('./scripts/lib/jst_time.js'); console.log(todayDateStrJST(${fixedNowMs}));`;
  const resultJST = runInChildWithTZ('Asia/Tokyo', code);
  const resultUTC = runInChildWithTZ('UTC', code);
  const resultNY = runInChildWithTZ('America/New_York', code);
  check('Asia/Tokyo環境で正しい日付(JST側で日付が進んだ2026-09-15)になる', resultJST === '2026-09-15');
  check('UTC環境でも同じ結果になる(OSタイムゾーンに依存しない)', resultUTC === '2026-09-15');
  check('America/New_York環境でも同じ結果になる(OSタイムゾーンに依存しない)', resultNY === '2026-09-15');
}

console.log('=== テスト2(受入監査指摘1): hoursSinceDeadlineもTZ環境変数に依存せず同じ結果になる ===');
{
  // JST 2026-09-15 10:30 の締切から3.5時間後 = JST 2026-09-15 14:00 の時点で確認する
  const nowMs = Date.UTC(2026, 8, 15, 5, 0, 0); // UTC 05:00 = JST 14:00
  const code = `const {hoursSinceDeadline}=require('./scripts/lib/race_ops_result_fetch.js'); console.log(hoursSinceDeadline('2026-09-15','10:30', ${nowMs}).toFixed(2));`;
  const resultJST = runInChildWithTZ('Asia/Tokyo', code);
  const resultUTC = runInChildWithTZ('UTC', code);
  const resultNY = runInChildWithTZ('America/New_York', code);
  check('Asia/Tokyo環境で3.50時間になる', resultJST === '3.50');
  check('UTC環境でも3.50時間になる(OSタイムゾーンに依存しない)', resultUTC === '3.50');
  check('America/New_York環境でも3.50時間になる(OSタイムゾーンに依存しない)', resultNY === '3.50');
}

console.log('=== テスト3: nowJSTIsoもTZ環境変数に依存せず同じ絶対時刻を指す ===');
{
  const fixedNowMs = Date.UTC(2026, 8, 14, 12, 0, 0);
  const code = `const {nowJSTIso}=require('./scripts/lib/jst_time.js'); console.log(nowJSTIso(${fixedNowMs}));`;
  const resultJST = runInChildWithTZ('Asia/Tokyo', code);
  const resultUTC = runInChildWithTZ('UTC', code);
  check('TZ環境変数を変えても同じ値になる', resultJST === resultUTC);
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
