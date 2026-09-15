'use strict';
// scripts/race_ops_server.js の起動の恒久性(多重起動防止・ポート競合時の挙動)に関する回帰テスト。
// 2026-09-15夜(GARON RaceOps引継ぎ文書の指摘「V2導入後も旧プロセスがポートを保持し続けた」への
// 再発防止対応)。実際のTailscale・iPhone・本番ポート(47871)には触れず、PIDロックファイルの
// 差し替え口(LOCK_PATH)と一時的なローカルポートだけで検証する。
//
// 使い方: node tests/race_ops_server_startup.regression.test.js

const fs = require('fs');
const { spawnSync } = require('child_process');
const { startServer, acquireLock, releaseLock, LOCK_PATH } = require('../scripts/race_ops_server');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

function cleanupLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (e) { /* ignore */ }
}

// spawnSyncはプロセスが終了するまで待つため、戻り値のpidは「かつて存在したが今は確実に終了している」PID。
// (ごく低確率でOSがそのPIDを別プロセスへ再利用する競合はあるが、本番コード自体が同じ前提で動く
// PID生死確認ロックであり、既存コードベースの他スクリプトも同じ方式を使っている)。
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

async function main() {
  console.log('=== テスト1: ロックファイルが存在しない場合、acquireLockはtrueを返し自分のPIDを書き込む ===');
  {
    cleanupLock();
    const ok = acquireLock();
    check('acquireLockはtrueを返す', ok === true);
    check('ロックファイルに自分のPIDが書き込まれる', fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid));
    releaseLock();
    check('releaseLockでロックファイルが削除される', !fs.existsSync(LOCK_PATH));
  }

  console.log('=== テスト2(受入監査指摘7の再発防止): 生存中のPIDがロックされている場合、acquireLockはfalseを返す(多重起動防止) ===');
  {
    cleanupLock();
    fs.writeFileSync(LOCK_PATH, String(process.pid)); // 自分自身のPID=確実に生存中
    const ok = acquireLock();
    check('acquireLockはfalseを返す(既に別プロセスが稼働中とみなす)', ok === false);
    check('ロックファイルは書き換えられない(元のPIDのまま)', fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid));
    cleanupLock();
  }

  console.log('=== テスト3(GARON RaceOps引継ぎ指摘の再発防止): 死んでいるPIDがロックされている場合、acquireLockはtrueを返し古いロックを上書きする(スタックロック放置を防ぐ) ===');
  {
    cleanupLock();
    const stalePid = deadPid();
    fs.writeFileSync(LOCK_PATH, String(stalePid));
    const ok = acquireLock();
    check('acquireLockはtrueを返す(スタックロックを乗り越えて起動できる)', ok === true);
    check('ロックファイルが自分のPIDへ上書きされる', fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid));
    releaseLock();
  }

  console.log('=== テスト4(GARON RaceOps引継ぎ指摘の再発防止): 同一ポートで二重起動しようとした場合、startServerはハングせず明確に失敗する ===');
  {
    const PORT = 47999; // 本番ポート(47871)とは異なる、テスト専用の固定ポート
    const server1 = await startServer(PORT);
    try {
      let rejected = null;
      try {
        await startServer(PORT);
      } catch (e) {
        rejected = e;
      }
      check('2つ目のstartServerはEADDRINUSEで失敗する(ポートを保持したまま応答しなくなることはない)', !!rejected && rejected.code === 'EADDRINUSE');
    } finally {
      server1.close();
    }
  }

  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  cleanupLock();
  process.exit(1);
});
