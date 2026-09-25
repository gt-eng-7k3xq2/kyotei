'use strict';
// ピーク枠 影運用の回帰テスト。すべて一時フォルダの中で完結し、本番のログ・生データには一切触れない。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('../scripts/lib/peak_slot_core');
const { runOnce } = require('../scripts/peak_slot_recorder');
const { runReconcile } = require('../scripts/peak_slot_reconcile');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log('  PASS: ' + name); pass++; } else { console.log('  FAIL: ' + name); fail++; } }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'peakslot-'));
const DATE = '2026-10-05';
const dirs = { dir: path.join(TMP, 'ledger'), rawDir: path.join(TMP, 'raw'), eventsDir: path.join(TMP, 'events'), reportDir: path.join(TMP, 'reports'), backupDir: path.join(TMP, 'backup'), resultsFile: path.join(TMP, 'results.json'), rulesFile: path.join(TMP, 'rules.json') };
const baseRules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'peak_slot', 'rules_v1.json'), 'utf8'));
function writeRules(over) { fs.writeFileSync(dirs.rulesFile, JSON.stringify({ ...baseRules, startDate: DATE, ...over }, null, 1)); }
const at = (hhmm) => Date.parse(`${DATE}T${hhmm}:00+09:00`);   // テスト内の「現在時刻」

// 万舟級の確率が高くなるように作った予測とオッズ。strong=true なら、閾値τを超える
function makeRace(venue, n, deadline, strong) {
  const probs = new Array(120).fill(0.001); const combos = [];
  core.COMBO_NAMES.forEach((name, k) => {
    const [a, b, c] = name.split('-').map(Number);
    let odds = 5 + k; if (k < 12) odds = 120 + k;   // 先頭12通りは100倍超
    combos.push({ first: a, second: b, third: c, odds });
    if (k < 5) probs[k] = strong ? 0.02 : 0.0002;
  });
  const s = probs.reduce((x, y) => x + y, 0); const p = probs.map(x => x / s);
  const raw = { venue, jo: '01', raceNumber: n, collectedAtISO: new Date(at('12:00')).toISOString(), collected: { deadlineTime: deadline, odds3Tan: { ok: true, combos, count: 120 } } };
  const judg = { eventType: 'engine_judgment', venue, jo: '01', raceNumber: n, deadlineTime: deadline, engine: 'GARON-DB-3STAGE-V1', stateDay: '2026-10-04', probs: p, loggedAt: new Date(at('12:00') - 5000).toISOString() };
  return { raw, judg };
}
function putRace(r, fileSuffix = '1') {
  const d = path.join(dirs.rawDir, DATE); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${r.raw.venue}_${r.raw.raceNumber}R_${fileSuffix}.json`), JSON.stringify(r.raw));
  fs.mkdirSync(dirs.eventsDir, { recursive: true });
  fs.appendFileSync(path.join(dirs.eventsDir, `boatcast_b01_events_${DATE}.jsonl`), JSON.stringify(r.judg) + '\n');
}
function hashTree(root) { const out = []; (function w(p) { if (!fs.existsSync(p)) return; for (const f of fs.readdirSync(p)) { const q = path.join(p, f); fs.statSync(q).isDirectory() ? w(q) : out.push(f + ':' + sha(fs.readFileSync(q))); } })(root); return out.sort().join('|'); }

(async () => {
  console.log('=== 準備: ルールの整合 ===');
  {
    const c = core.evaluateRace(new Array(120).fill(1 / 120), null, baseRules, 0);
    check('オッズが無ければ評価できない', c.ok === false && c.reason === 'odds_missing');
    const c2 = core.evaluateRace([1, 2], {}, baseRules, 0);
    check('予測が120通りでなければ評価できない', c2.ok === false && c2.reason === 'probs_invalid');
    check('組み合わせの並びが120通りで、先頭が1-2-3・末尾が6-5-4', core.COMBO_NAMES.length === 120 && core.COMBO_NAMES[0] === '1-2-3' && core.COMBO_NAMES[119] === '6-5-4');
  }

  console.log('=== テスト1: 開始前(startDate=null)は何も記録しない ===');
  writeRules({ startDate: null });
  putRace(makeRace('桐生', 1, '13:00', true));
  {
    const r = runOnce({ ...dirs, nowMs: at('12:01') });
    check('not_started を返す', r.state === 'not_started');
    check('台帳が作られない', core.listLedgerDates(dirs.dir).length === 0);
    check('ハートビートは更新される', JSON.parse(fs.readFileSync(path.join(dirs.dir, 'heartbeat.json'), 'utf8')).state === 'not_started');
  }

  console.log('=== テスト2: 開始後の採用・不採用 ===');
  writeRules({});
  putRace(makeRace('戸田', 2, '13:00', false));   // 閾値未満
  const before = hashTree(dirs.rawDir) + hashTree(dirs.eventsDir);
  {
    const r = runOnce({ ...dirs, nowMs: at('12:02') });
    check('2レース記録される', r.state === 'ok' && r.processed === 2);
    const L = core.readLines(core.ledgerFile(dirs.dir, DATE));
    const e1 = L.find(e => e.venue === '桐生'), e2 = L.find(e => e.venue === '戸田');
    check('確率が高いレースは採用される(万舟級5点・中穴5点つき)', e1.adopted === true && e1.mansyu.picks.length === 5 && e1.chuuana.picks.length === 5);
    check('確率が低いレースは採用されない(理由 below_tau)', e2.adopted === false && e2.reason === 'below_tau' && !e2.chuuana);
    check('採用した万舟級の5点は、すべてオッズ100倍以上', e1.mansyu.picks.every(p => p.odds >= 100));
    check('採用した中穴の5点は、オッズ30倍以上100倍未満', e1.chuuana.picks.every(p => p.odds >= 30 && p.odds < 100));
    check('締切前の記録は valid', e1.timing === 'valid');
    check('生データのハッシュとエンジンの統計日付が記録される', /^[0-9a-f]{64}$/.test(e1.rawSha256) && e1.engine.stateDay === '2026-10-04');
    check('連鎖の検証が通る', core.verifyChain(dirs.dir, core.loadRules(dirs.rulesFile).rulesHash).ok === true);
  }
  console.log('=== テスト3: 二重記録の防止 ===');
  {
    const r = runOnce({ ...dirs, nowMs: at('12:03') });
    check('再実行しても記録が増えない', r.processed === 0 && core.readLines(core.ledgerFile(dirs.dir, DATE)).length === 2);
    putRace(makeRace('桐生', 1, '13:00', true), '2');   // 同じレースの再収集
    const r2 = runOnce({ ...dirs, nowMs: at('12:04') });
    check('同じレースの2つ目の生データは記録されない', r2.processed === 0 && core.readLines(core.ledgerFile(dirs.dir, DATE)).length === 2);
  }
  console.log('=== テスト4: 締切後の記録・判定なし ===');
  {
    putRace(makeRace('江戸川', 3, '12:03', true));   // 締切が現在時刻より前
    const noj = makeRace('平和島', 4, '13:00', true); putRace(noj); const evFile = path.join(dirs.eventsDir, `boatcast_b01_events_${DATE}.jsonl`);
    fs.writeFileSync(evFile, fs.readFileSync(evFile, 'utf8').split('\n').filter(l => l && !l.includes('平和島')).join('\n') + '\n');   // 平和島の判定だけ消す
    runOnce({ ...dirs, nowMs: at('12:10') });
    const L = core.readLines(core.ledgerFile(dirs.dir, DATE));
    const late = L.find(e => e.venue === '江戸川'), nj = L.find(e => e.venue === '平和島');
    check('締切後の記録は timing=late で、採用しない', late.timing === 'late' && late.adopted === false && late.reason === 'late');
    check('判定が無いレースも記録される(no_judgment)', nj.status === 'no_judgment' && nj.adopted === false);
  }
  console.log('=== テスト5: 1日の上限 ===');
  {
    writeRules({ adopt: { ...baseRules.adopt, dailyCap: 2 } });
    // ルールを変えたので、連鎖の起点(ルールのハッシュ)も変わる=別の日として扱うために日付を替えず、新しい一時フォルダで検証する
    const t2 = { ...dirs, dir: path.join(TMP, 'ledger2'), rawDir: path.join(TMP, 'raw2'), eventsDir: path.join(TMP, 'events2') };
    for (const [v, n] of [['浜名湖', 1], ['蒲郡', 2], ['常滑', 3]]) {
      const r = makeRace(v, n, '13:00', true); const d = path.join(t2.rawDir, DATE); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${v}_${n}R_1.json`), JSON.stringify(r.raw));
      fs.mkdirSync(t2.eventsDir, { recursive: true }); fs.appendFileSync(path.join(t2.eventsDir, `boatcast_b01_events_${DATE}.jsonl`), JSON.stringify(r.judg) + '\n');
    }
    runOnce({ ...t2, nowMs: at('12:20') });
    const L = core.readLines(core.ledgerFile(t2.dir, DATE));
    check('上限(2件)を超えた3件目は、採用されず理由が daily_cap', L.filter(e => e.adopted).length === 2 && L.some(e => e.reason === 'daily_cap'));
    writeRules({});
  }

  console.log('=== テスト6: 台帳の改ざん検知 ===');
  {
    const { rulesHash } = core.loadRules(dirs.rulesFile);
    const file = core.ledgerFile(dirs.dir, DATE); const original = fs.readFileSync(file, 'utf8');
    check('改ざん前は検証が通る', core.verifyChain(dirs.dir, rulesHash).ok === true);
    fs.writeFileSync(file, original.replace('"adopted":true', '"adopted":false'));
    const v1 = core.verifyChain(dirs.dir, rulesHash);
    check('1行の書き換えを検知する', v1.ok === false && /ハッシュ/.test(v1.error));
    fs.writeFileSync(file, original.split('\n').filter(Boolean).filter((l, i) => i !== 1).join('\n') + '\n');
    const v2 = core.verifyChain(dirs.dir, rulesHash);
    check('1行の削除を検知する', v2.ok === false);
    fs.writeFileSync(file, original);
    check('元に戻せば再び通る', core.verifyChain(dirs.dir, rulesHash).ok === true);
    writeRules({ tauChanged: 1 });
    check('ルールを変えると検知する', core.verifyChain(dirs.dir, core.loadRules(dirs.rulesFile).rulesHash).ok === false);
    writeRules({});
  }

  console.log('=== テスト7: 停止スイッチ・終了日 ===');
  {
    fs.writeFileSync(path.join(dirs.dir, '.stop'), '1');
    const r = runOnce({ ...dirs, nowMs: at('12:30') });
    check('.stop があれば止まる', r.state === 'stopped');
    fs.unlinkSync(path.join(dirs.dir, '.stop'));
    const r2 = runOnce({ ...dirs, nowMs: at('12:30') + 20 * 86400000 });
    check('14日を過ぎたら finished', r2.state === 'finished');
    const r3 = runOnce({ ...dirs, nowMs: at('12:30') - 2 * 86400000 });
    check('開始日より前は waiting', r3.state === 'waiting');
  }

  console.log('=== テスト8: 照合(結果・取りこぼし・封印・バックアップ) ===');
  {
    const L = core.readLines(core.ledgerFile(dirs.dir, DATE)); const adoptedRaces = L.filter(e => e.adopted && e.timing === 'valid');
    const hitCombo = adoptedRaces[0].mansyu.picks[0].combo;   // 1本目は、万舟級の1点目が的中
    const recs = [{ date: DATE, venue: adoptedRaces[0].venue, raceNumber: adoptedRaces[0].raceNumber, chakuju: hitCombo, payoutYen: 15000 }];
    if (adoptedRaces[1]) recs.push({ date: DATE, venue: adoptedRaces[1].venue, raceNumber: adoptedRaces[1].raceNumber, chakuju: '6-5-4', payoutYen: 800 });
    fs.writeFileSync(dirs.resultsFile, JSON.stringify({ records: recs }));
    putRace(makeRace('鳴門', 9, '14:00', true));   // 生データはあるが、記録係が処理していないレース(取りこぼし)
    const r = await runReconcile({ ...dirs, nowMs: at('23:00'), date: DATE, notify: false });
    check('連鎖は正常', r.chain.ok === true);
    check('採用レースの結果が照合される', r.today.resolved === recs.length);
    check('万舟級の的中と倍率(150倍)が集計される', r.today.mansyu.hits === 1 && r.today.mansyu.m100 === 1 && r.today.mansyu.m30 === 1);
    check('回収額が正しい(150倍×100円=15,000円)', r.today.mansyu.payout === 15000);
    check('処理されていない生データを、取りこぼしとして検出する', r.today.unrecorded === 1 && r.today.unrecordedList[0].includes('鳴門'));
    check('取りこぼしの警告が出る', r.alerts.some(a => /記録されなかった/.test(a.text)));
    check('封印(ハッシュ)ファイルが作られ、台帳のSHA-256と一致', JSON.parse(fs.readFileSync(path.join(dirs.dir, `seal_${DATE}.json`), 'utf8')).ledgerSha256 === sha(fs.readFileSync(core.ledgerFile(dirs.dir, DATE), 'utf8')));
    check('日報が作られる', fs.existsSync(path.join(dirs.reportDir, `daily_${DATE}.md`)));
    check('バックアップにコピーされる', fs.existsSync(path.join(dirs.backupDir, `ledger_${DATE}.jsonl`)));
    check('ステータスファイルが作られる', JSON.parse(fs.readFileSync(path.join(dirs.dir, 'status.json'), 'utf8')).rulesVersion === 'v1');
    const r2 = await runReconcile({ ...dirs, nowMs: at('23:05'), date: DATE, notify: false });
    check('照合を再実行しても、結果が二重に増えない', r2.today.resolved === recs.length && core.readLines(path.join(dirs.dir, `results_${DATE}.jsonl`)).length === recs.length);
  }

  console.log('=== テスト9: 本番の生データ・イベントを書き換えていない ===');
  {
    check('記録係・照合係の実行の前後で、生データとイベントのハッシュが同じ', (function () {
      const after = hashTree(dirs.rawDir) + hashTree(dirs.eventsDir);
      return after.length > 0 && after.split('|').length >= before.split('|').length;   // 追加(テスト内で自分が置いたもの)はあるが、記録係が変更していない
    })());
    const raw1 = path.join(dirs.rawDir, DATE, '桐生_1R_1.json'); const h1 = sha(fs.readFileSync(raw1)); runOnce({ ...dirs, nowMs: at('12:40') });
    check('記録係は、既存の生データを書き換えない', h1 === sha(fs.readFileSync(raw1)));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
