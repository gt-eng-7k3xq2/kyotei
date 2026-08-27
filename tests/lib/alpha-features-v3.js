'use strict';
// エンジンα v3: v2(5系統のz-score化)に、Qエンジンがスコアリングに一切使っていない
// 新しい生フィールドを追加する。garon_q_engine.htmlでmotorContribP/sessonPt/fCountを
// grepした結果、いずれも表示・パース処理でのみ使われており、rankBoatsBySystem/
// evaluateBoatSupportのスコア計算には組み込まれていないことを確認済み(2026-08-27)。
//   - motorContribP: モーター貢献度(motor2renとは別の指標)
//   - sessonPt: 今節成績(直近の連戦フォーム、6ヶ月等の長期統計とは別軸)
//   - fCount: フライング回数(リスク指標、多いほど不利なので符号反転)

const { zscore } = require('./alpha-features-v2.js');

function buildFeaturesV3(boats, calcAvgST) {
  const stRaw = boats.map(b => { const v = calcAvgST(b); return v == null ? null : -v; });
  const kimariteRaw = boats.map((b, idx) => idx === 0 ? (b.kimariteNige6m || null) : Math.max(b.sashi6m || 0, b.makuri6m || 0, b.makurisashi6m || 0));
  const renRaw = boats.map(b => {
    const periods = ['今期', '直近 6ヶ月', '直近 3ヶ月', '一般戦'];
    const rates = periods.map(p => b.wakuStats && b.wakuStats.niren2 && b.wakuStats.niren2[p]).filter(v => v && v.n >= 8);
    return rates.length ? rates.reduce((s, v) => s + v.rate, 0) / rates.length : null;
  });
  const motorRaw = boats.map(b => b.motor2ren || null);
  const exhibitMetrics = [
    boats.map(b => b.tenji != null ? -b.tenji : null),
    boats.map(b => b.syukai != null ? -b.syukai : null),
    boats.map(b => b.syukaiFoot != null ? -b.syukaiFoot : null),
    boats.map(b => b.chokusen != null ? -b.chokusen : null),
  ];
  const exhibitZs = exhibitMetrics.map(zscore);
  const exhibitCombined = boats.map((_, i) => exhibitZs.reduce((s, z) => s + z[i], 0) / exhibitZs.length);

  // 新規: 表示専用で終わっていた3フィールド
  const motorContribRaw = boats.map(b => (b.motorContribP != null ? b.motorContribP : null));
  const sessonRaw = boats.map(b => (b.sessonPt != null && b.sessonPt !== 0 ? b.sessonPt : null)); // 0は「データ無し」扱いに近いため除外気味
  const fCountRaw = boats.map(b => (b.fCount != null ? -b.fCount : null)); // 多いほど悪いので符号反転

  const stZ = zscore(stRaw);
  const kimariteZ = zscore(kimariteRaw);
  const renZ = zscore(renRaw);
  const motorZ = zscore(motorRaw);
  const motorContribZ = zscore(motorContribRaw);
  const sessonZ = zscore(sessonRaw);
  const fCountZ = zscore(fCountRaw);

  return boats.map((b, i) => {
    const course = b.no;
    const courseDummies = [2, 3, 4, 5, 6].map(c => (course === c ? 1 : 0));
    return [...courseDummies, stZ[i], kimariteZ[i], renZ[i], motorZ[i], exhibitCombined[i], motorContribZ[i], sessonZ[i], fCountZ[i]];
  });
}

const FEATURE_NAMES_V3 = ['course2', 'course3', 'course4', 'course5', 'course6', 'st_z', 'kimarite_z', 'ren_z', 'motor_z', 'exhibit_z', 'motorContrib_z', 'sesson_z', 'fCount_z'];

module.exports = { buildFeaturesV3, FEATURE_NAMES_V3 };
