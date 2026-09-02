'use strict';
// GARON-20260901-003 継続(CEO承認、2026-09-02): 目標(1日10本前後・帯内的中率20%・ROI改善)に
// 対応した研究用エンジンの最小仕様。「比較基準」として市場オッズ昇順・帯内8点固定を実装する。
// これは新しい勝てるエンジンではない。Qのformationsには依存しない構造(全120通りを候補にできる)。
// 新しいモデル学習・閾値探索・複数案の総当たりは行わない。本番Q・通知・紙上記録・原本・公開設定は無変更。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POINTS_FIXED = 8; // 研究用の暫定仕様(比較用の仮置き、本番の点数変更承認ではない)
const FLAT_STAKE = 100;
const DAILY_CAP = 10;

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMin(s) { if (!s) return null; const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function loadAllRaces() {
  const files = fs.readdirSync(ROOT).filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const races = [];
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); for (const r of d) races.push(r); }
  return races;
}
function isUsable(r) {
  return r.resulted && r.oddsMap && Object.keys(r.oddsMap).length > 0 &&
    r.boats && r.boats.length === 6 && r.boats.every(b => !b.isJogai) && r.chakuju;
}
function classifyOddsTiming(r) {
  if (!r.archivedAt) return { cls: 'unknown' };
  const archJST = new Date(new Date(r.archivedAt).getTime() + 9 * 3600 * 1000);
  const archDateJST = archJST.toISOString().slice(0, 10);
  const archMinJST = archJST.getUTCHours() * 60 + archJST.getUTCMinutes();
  const sMin = shimekiriMin(r.shimekiri);
  if (archDateJST === r.date && sMin != null) {
    const diff = sMin - archMinJST;
    if (diff >= 0 && diff <= 20) return { cls: 'true' };
  }
  return { cls: 'unknown' };
}

// ===== 買い目順位付け(比較基準): 市場オッズ昇順、同値は点表記の文字列昇順(結果と無関係な固定規則) =====
function rankByOddsAscending(bandEntries) {
  return bandEntries.slice().sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
}

// ===== レコード構築: 全120通りを候補にできる構造(Qのformationsには依存しない) =====
function buildRecord(r, rankFn, pointsWanted) {
  const oddsMap = r.oddsMap || {};
  const validOddsEntries = Object.entries(oddsMap).filter(([, v]) => parseFloat(v) > 0);
  const validCount = validOddsEntries.length;
  if (validCount !== 120) return { skip: 'incomplete_odds', validCount };
  const bandEntries = validOddsEntries.filter(([, v]) => v >= 50 && v <= 150).map(([val, v]) => ({ val, odds: v }));
  if (bandEntries.length < pointsWanted) return { skip: 'insufficient_band_candidates', bandCount: bandEntries.length };
  const ranked = rankFn(bandEntries);
  const points = ranked.slice(0, pointsWanted).map(p => p.val);
  const sMin = shimekiriMin(r.shimekiri);
  return {
    skip: null, date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: sMin,
    points, chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
    bandCandidateCount: bandEntries.length,
  };
}

function applyDailyCap(pool) {
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  const dates = Object.keys(byDate).sort();
  const selected = []; const perDay = {};
  for (const date of dates) {
    const dayRaces = (byDate[date] || []).slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP); // 水増しなし、締切順のみ、同日後からの並べ替え禁止
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates };
}

function evaluate(pool) {
  let hit = 0, bandHit = 0, migratedOutHit = 0, stake = 0, payout = 0;
  const dayHitMap = {};
  for (const r of pool) {
    const isHit = r.chakuju && r.points.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isBandHit = isHit && isResultBand;
    const raceStake = r.points.length * FLAT_STAKE;
    let racePayout = 0;
    if (isHit) racePayout = Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    stake += raceStake; payout += racePayout;
    if (isHit) hit++;
    if (isBandHit) { bandHit++; dayHitMap[r.date] = true; }
    if (isHit && !isResultBand) migratedOutHit++;
  }
  const n = pool.length;
  return { n, hit, bandHit, migratedOutHit, stake, payout, roi: stake ? payout / stake * 100 : null, dayHitMap };
}

if (require.main === module) {
  console.log('=== 研究用エンジン最小仕様: 比較基準(市場オッズ昇順・帯内8点固定)の実装・評価(2026-09-02) ===\n');
  console.log('【明記】既存データ(2026-08-21〜08-31、真T-10)は開発用。これは「新しい勝てるエンジン」ではなく比較基準。\n');

  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  const trueT10 = usable.filter(r => classifyOddsTiming(r).cls === 'true');
  console.log('真T-10(締切前20分以内取得) n=', trueT10.length);

  const built = trueT10.map(r => buildRecord(r, rankByOddsAscending, POINTS_FIXED));
  const incomplete = built.filter(b => b.skip === 'incomplete_odds');
  const insufficient = built.filter(b => b.skip === 'insufficient_band_candidates');
  const pool = built.filter(b => !b.skip);
  console.log('全120通り有効オッズ不足で除外:', incomplete.length, '件');
  console.log('帯内候補が8点未満で見送り:', insufficient.length, '件(帯外補充なし)');
  console.log('候補プール(発信対象になり得るレース) n=', pool.length);

  const cap = applyDailyCap(pool);
  console.log('\n=== 締切順・1日10件上限適用後 ===');
  const res = evaluate(cap.selected);
  console.log('発信数(n) =', res.n, ' 日数=', cap.dates.length, ' 1日平均=', (res.n / cap.dates.length).toFixed(1));
  console.log('全的中数 =', res.hit, ' 全的中率 =', (res.hit / res.n * 100).toFixed(2) + '%');
  console.log('確定50-150倍着弾(主指標) =', res.bandHit, ' 帯内的中率 =', (res.bandHit / res.n * 100).toFixed(2) + '%');
  console.log('確定時に帯外へ動いた的中数 =', res.migratedOutHit);
  console.log('投資額 =', res.stake, ' 払戻額 =', res.payout, ' ROI =', res.roi.toFixed(1) + '%');
  console.log('無的中日数 =', cap.dates.filter(d => !res.dayHitMap[d]).length, '/', cap.dates.length);
  console.log('日別発信数:', cap.dates.map(d => `${d}:${cap.perDay[d].selectedCount}(候補${cap.perDay[d].poolCount})`).join('  '));
  console.log('\n目標との差: 1日平均', (res.n / cap.dates.length).toFixed(1), '本(目標10本) / 帯内的中率', (res.bandHit / res.n * 100).toFixed(2) + '%(目標20%、差', (20 - res.bandHit / res.n * 100).toFixed(1), 'pt)');

  const manifest = {
    generatedAt: new Date().toISOString(), spec: { pointsFixed: POINTS_FIXED, flatStake: FLAT_STAKE, dailyCap: DAILY_CAP },
    scopeNote: '既存データ(開発用)での記述的バックテスト。前向き評価は今後の未使用データで別途行う。新規モデル学習・閾値探索なし。',
    trueT10Count: trueT10.length, incompleteOddsCount: incomplete.length, insufficientBandCount: insufficient.length,
    poolCount: pool.length, result: { ...res, dayHitMap: undefined }, perDay: cap.perDay, dates: cap.dates,
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_engine_min_spec_baseline_2026-09-02.json'), JSON.stringify(manifest, null, 2));
  console.log('\n結果を logs/research_engine_min_spec_baseline_2026-09-02.json へ保存しました。');
}

module.exports = { buildRecord, rankByOddsAscending, applyDailyCap, evaluate, classifyOddsTiming, isUsable, shimekiriMin, parsePayout100, POINTS_FIXED, FLAT_STAKE, DAILY_CAP };
