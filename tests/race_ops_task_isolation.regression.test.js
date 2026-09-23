'use strict';
// 2026-09-15新設(受入監査指摘7「タスク導入を安全に分離する」):
// RaceOps専用のタスク登録・解除・状態確認スクリプトが、既存のGARON_*タスク(GARON_RealtimeScreening
// 等)に一切触れないことを、実際にPowerShellを実行せずソースコードの静的検査で確認する
// (タスク登録の実行そのものはCEO指示により行わない。読み取り専用の検査のみ)。
//
// 使い方: node tests/race_ops_task_isolation.regression.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const ROOT = path.join(__dirname, '..');
const RACE_OPS_TASK_NAMES = ['GARON_RaceOpsServer', 'GARON_RaceOpsResultUpdater', 'GARON_RaceOpsNightlyAnalysis', 'GARON_RaceOpsHealthCheck'];
// scripts/setup_scheduled_tasks.ps1 が本来管理する既存タスク名(2026-09-15時点で確認済みの一覧)。
// RaceOps専用スクリプト側にこれらの名前が一切現れないことを確認する。
const EXISTING_OTHER_TASK_NAMES = [
  'GARON_ArchiveBackup', 'GARON_CodexDailyResearch', 'GARON_DataQualityScan', 'GARON_DraftSkipReason',
  'GARON_EmergencyStop', 'GARON_FieldBackfillBatch', 'GARON_NightlyBackfill', 'GARON_NightlyDiagnosis',
  'GARON_NightlyGitCommit', 'GARON_NightlyReboot', 'GARON_NtfyHealthCheck', 'GARON_RealtimeScreening',
  'GARON_RealtimeScreeningWatchdog', 'GARON_RemoteControlAutostart', 'GARON_ResumeAutomation',
  'GARON_SiteBlockMonitor', 'GARON_UpdateDashboard',
];

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

console.log('=== テスト1: register_race_ops_tasks.ps1 はRaceOps専用タスク3件だけを登録し、既存タスク名を実際の操作対象にしない ===');
{
  const src = readSource('scripts/register_race_ops_tasks.ps1');
  for (const name of RACE_OPS_TASK_NAMES) {
    check(`${name} への言及がある`, src.includes(`"${name}"`));
  }
  // 説明コメント中の「GARON_SiteBlockMonitorと同じパターン」のような素の言及(引用符無し)は許容する
  // (設計意図の説明として有用)。危険なのは実際にコマンドレットの操作対象として
  // 引用符付きで指定されているケース(-TaskName "GARON_X"等)のみなので、そこだけを検査する。
  const touchedOthersAsTarget = EXISTING_OTHER_TASK_NAMES.filter((name) => src.includes(`"${name}"`));
  check('既存の他タスク名が引用符付き(=実際の操作対象)で一切出現しない', touchedOthersAsTarget.length === 0);
  check('Register-GaronTask(共有ヘルパー、既存18タスク分の登録ロジックと同じ関数)を呼び出していない', !src.includes('Register-GaronTask'));
}

console.log('=== テスト2: unregister_race_ops_tasks.ps1 はRaceOps専用タスク3件だけを解除対象にする ===');
{
  const src = readSource('scripts/unregister_race_ops_tasks.ps1');
  for (const name of RACE_OPS_TASK_NAMES) {
    check(`${name} への言及がある`, src.includes(name));
  }
  const touchedOthers = EXISTING_OTHER_TASK_NAMES.filter((name) => src.includes(name));
  check('既存の他タスク名への言及が一切無い', touchedOthers.length === 0);
}

console.log('=== テスト3: status_race_ops_tasks.ps1 はRaceOps専用タスク3件だけを問い合わせる(読み取り専用) ===');
{
  const src = readSource('scripts/status_race_ops_tasks.ps1');
  for (const name of RACE_OPS_TASK_NAMES) {
    check(`${name} への言及がある`, src.includes(name));
  }
  const touchedOthers = EXISTING_OTHER_TASK_NAMES.filter((name) => src.includes(name));
  check('既存の他タスク名への言及が一切無い', touchedOthers.length === 0);
  check('書き込み系コマンドレット(Register-/Unregister-/Set-ScheduledTask)を一切使わない', !/Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask/.test(src));
}

console.log('=== テスト4(2026-09-15、受入監査指摘7の核心): setup_scheduled_tasks.ps1 はRaceOpsタスクの登録ロジックを一切含まない ===');
{
  const src = readSource('scripts/setup_scheduled_tasks.ps1');
  for (const name of RACE_OPS_TASK_NAMES) {
    check(`${name}の実際の登録コマンド(Register-ScheduledTask/Register-GaronTask呼び出し)が無い(説明コメントのみは許容)`,
      !new RegExp(`(Register-ScheduledTask|Register-GaronTask)[^\\n]*"${name}"`).test(src));
  }
  check('既存の他タスク名は引き続き含まれている(このファイル自体は削除・破壊されていない)',
    EXISTING_OTHER_TASK_NAMES.every((name) => src.includes(name)));
}

console.log('=== テスト5: run_race_ops_server.cmd / run_race_ops_analysis.cmd / run_race_ops_result_updater.cmd が存在し、対応するスクリプトを起動する ===');
{
  const pairs = [
    ['scripts/run_race_ops_server.cmd', 'race_ops_server.js'],
    ['scripts/run_race_ops_analysis.cmd', 'race_ops_analysis.js'],
    ['scripts/run_race_ops_result_updater.cmd', 'race_ops_result_updater.js'],
    ['scripts/run_race_ops_healthcheck.cmd', 'race_ops_healthcheck.js'],
  ];
  for (const [cmdPath, scriptName] of pairs) {
    const full = path.join(ROOT, cmdPath);
    check(`${cmdPath} が存在する`, fs.existsSync(full));
    if (fs.existsSync(full)) {
      const content = fs.readFileSync(full, 'utf8');
      check(`${cmdPath} が ${scriptName} を起動する`, content.includes(scriptName));
      // eslint-disable-next-line no-control-regex
      const nonAscii = [...content].some((ch) => ch.charCodeAt(0) > 127);
      check(`${cmdPath} は非ASCII文字を含まない(過去のタスク無音起動失敗の再発防止)`, !nonAscii);
    }
  }
}

console.log('=== テスト6(2026-09-23): GARON_RaceOpsHealthCheckだけがRunLevel Highestで、既存3タスクはLimitedのまま(予想ロジック本体のプロセスに昇格権限を渡さない) ===');
{
  const src = readSource('scripts/register_race_ops_tasks.ps1');
  const blocks = {
    GARON_RaceOpsServer: src.split('$serverPrincipal =')[1] && src.split('$serverPrincipal =')[1].split('\n')[0],
    GARON_RaceOpsResultUpdater: src.split('$updaterPrincipal =')[1] && src.split('$updaterPrincipal =')[1].split('\n')[0],
    GARON_RaceOpsNightlyAnalysis: src.split('$analysisPrincipal =')[1] && src.split('$analysisPrincipal =')[1].split('\n')[0],
    GARON_RaceOpsHealthCheck: src.split('$healthPrincipal =')[1] && src.split('$healthPrincipal =')[1].split('\n')[0],
  };
  check('GARON_RaceOpsServerはRunLevel Limited', /RunLevel Limited/.test(blocks.GARON_RaceOpsServer || ''));
  check('GARON_RaceOpsResultUpdaterはRunLevel Limited', /RunLevel Limited/.test(blocks.GARON_RaceOpsResultUpdater || ''));
  check('GARON_RaceOpsNightlyAnalysisはRunLevel Limited', /RunLevel Limited/.test(blocks.GARON_RaceOpsNightlyAnalysis || ''));
  check('GARON_RaceOpsHealthCheckはRunLevel Highest', /RunLevel Highest/.test(blocks.GARON_RaceOpsHealthCheck || ''));
}

console.log('=== テスト7(2026-09-23): race_ops_healthcheck.jsは、対象確認できたときだけプロセスを終了し、対象はrace_ops_server限定 ===');
{
  const src = readSource('scripts/race_ops_healthcheck.js');
  check('確認できなければ殺さない(falseを返す分岐がある)', /return false;/.test(src));
  check('Stop-Processの対象はrace_ops_server.jsの照合が通ったPIDのみ', src.includes('verifyLockedPidIsRaceOpsServer'));
  check('他プロセス名(realtime_screening等)を再起動対象にしていない', !/realtime_screening|result_updater\.js.*Start-ScheduledTask|nightly_analysis.*Start-ScheduledTask/.test(src));
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
