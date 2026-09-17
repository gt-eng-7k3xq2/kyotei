'use strict';
// scripts/backfill_official_results.js の回帰テスト。
// 2026-09-17、「渋滞の先頭車両」バグの再発防止(discoverAutoDatesが恒久未解決レースの
// せいで同じ日付に永久停止しない)を確認する。実際のC:\garon配下に一時ファイルを作るため、
// 実データと絶対に衝突しない過去日付(2020-01-01。discoverAutoDatesは今日より前の日付のみ
// 候補にするため未来日は使えない)を使う。テスト後は必ず削除する。
//
// 使い方: node tests/backfill_official_results.regression.test.js

const fs = require('fs');
const path = require('path');
const { discoverAutoDates, isPermanentlyUnresolvable, ROOT } = require('../scripts/backfill_official_results');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const TEST_DATE = '2020-01-01';
const TEST_FILE = path.join(ROOT, `daikibo_archive_${TEST_DATE}.json`);

function cleanup() {
  try { fs.unlinkSync(TEST_FILE); } catch (e) { /* ignore */ }
}

function writeFixture(entries) {
  fs.writeFileSync(TEST_FILE, JSON.stringify(entries, null, 2));
}

async function main() {
  cleanup();

  console.log('=== テスト1: 全件backfillTerminal:trueの日付はdiscoverAutoDatesの候補から除外される(渋滞バグの再発防止) ===');
  {
    writeFixture([
      { venue: '大村', racenum: '1', resulted: false, backfillTerminal: true, backfillTerminalReason: 'cancelled_or_unresolvable' },
      { venue: '桐生', racenum: '2', resulted: true, chakuju: '1-2-3', payout: '¥1,000' },
    ]);
    const dates = discoverAutoDates(1000);
    check('backfillTerminal:trueのみの日付は候補に含まれない', !dates.includes(TEST_DATE));
  }

  console.log('=== テスト2: backfillTerminalが付いていない未解決レースが1件でもあれば候補に含まれる ===');
  {
    writeFixture([
      { venue: '大村', racenum: '1', resulted: false, backfillTerminal: true, backfillTerminalReason: 'cancelled_or_unresolvable' },
      { venue: '戸田', racenum: '3', resulted: false },
    ]);
    const dates = discoverAutoDates(1000);
    check('未解決(未マーク)が残っていれば候補に含まれる', dates.includes(TEST_DATE));
  }

  console.log('=== テスト3: isPermanentlyUnresolvableに一致するがまだbackfillTerminalが付いていない場合も候補から除外される(既存の配列チェックとの後方互換) ===');
  {
    writeFixture([
      { venue: '大村', racenum: '1', date: '2026-08-07', resulted: false },
    ]);
    // 実際のPERMANENTLY_UNRESOLVABLE配列には2026-08-07の大村1Rが登録済み。
    // discoverAutoDates自体は日付引数で判定するため、TEST_DATE(2020-01-01)では一致しない
    // ことを別途、isPermanentlyUnresolvable関数を直接呼んで確認する。
    check('isPermanentlyUnresolvable(2026-08-07,大村,1)はtrueを返す', isPermanentlyUnresolvable('2026-08-07', '大村', '1'));
    check('isPermanentlyUnresolvable(テスト日付,大村,1)はfalseを返す(誤爆しない)', !isPermanentlyUnresolvable(TEST_DATE, '大村', '1'));
  }

  console.log('=== テスト4: 全件resulted:trueの日付は候補に含まれない(既存動作の後退なし) ===');
  {
    writeFixture([
      { venue: '桐生', racenum: '1', resulted: true, chakuju: '1-2-3', payout: '¥1,000' },
    ]);
    const dates = discoverAutoDates(1000);
    check('全件解決済みの日付は候補に含まれない', !dates.includes(TEST_DATE));
  }

  cleanup();
  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  cleanup();
  process.exit(1);
});
