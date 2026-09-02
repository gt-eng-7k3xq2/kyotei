'use strict';
// GARON-20260901-003 継続、CEO指示(2026-09-02): 研究・学習は行わず、v9凍結ファイルのkeysUsed
// (v10の学習対象6,022レース)について、現在のアーカイブから未加工(順位化前)のboats等をコピー
// するだけの受け渡し作業。当時の凍結済み生データは存在しない(v9の凍結学習ファイルは既にランク
// 変換済みの特徴量のみを保持しており、生のboatsは含まれていない)ため、現在のアーカイブから
// 新しい学習用スナップショットとして取得し、「元のv10入力の復元」とは呼ばない。
// 既存の凍結物(v9/v10のいずれのJSONも)は一切上書きしない。原本(daikibo_archive_*.json)も
// 変更しない(読み取りのみ)。モデル学習・特徴量計算は一切行わない。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadAllRaces } = require('./q_engine_entry_backtest.js');

const ROOT = path.join(__dirname, '..');

function hashObj(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }

function main() {
  const snapshotAt = new Date().toISOString();
  console.log('=== v10学習対象(v9 keysUsed)の未加工データ受け渡し(2026-09-02) ===\n');
  console.log('【明記】研究・学習・特徴量計算は行わない。原本は変更しない(読み取りのみ)。既存の凍結物は上書きしない。');
  console.log('【明記】当時の凍結済み生データ(boats等)は存在しない。以下は現在のアーカイブから取得した新しい学習用スナップショット(取得日時=' + snapshotAt + ')であり、「元のv10入力の復元」ではない。\n');

  const v9FrozenTrain = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v9_frozen_train_2026-09-02.json'), 'utf8'));
  const targetKeys = v9FrozenTrain.keysUsed;
  console.log('対象キー数(v9 keysUsed) =', targetKeys.length);

  const all = loadAllRaces();
  console.log('現在のアーカイブ総レコード数 =', all.length);

  // キーごとの件数を数え、重複を検出する(date_venue_racenumの組み合わせ)
  const byKey = new Map();
  for (const r of all) {
    const k = `${r.date}_${r.venue}_${r.racenum}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }

  const found = [];
  const notFound = [];
  const duplicated = [];
  for (const key of targetKeys) {
    const matches = byKey.get(key);
    if (!matches || matches.length === 0) { notFound.push(key); continue; }
    if (matches.length > 1) { duplicated.push({ key, count: matches.length }); continue; } // 勝手に1件を選ばない
    const r = matches[0];
    found.push({
      raceId: key, date: r.date, venue: r.venue, racenum: r.racenum,
      boats: r.boats, // 順位化前のまま(rankBoatsBySystem等を一切適用しない、生の配列をそのままコピー)
      chakuju: r.chakuju, resulted: r.resulted,
      provenance: { id: r.id, archivedAt: r.archivedAt || null, _fieldsRefreshedAt: r._fieldsRefreshedAt || null },
    });
  }

  console.log('\n=== 結果 ===');
  console.log('取得できた件数 =', found.length);
  console.log('見つからなかった件数 =', notFound.length);
  console.log('重複していた件数(キーは一致するが複数レコード、補完せず一覧化のみ) =', duplicated.length);
  if (notFound.length) console.log('見つからないID一覧(先頭20件):', notFound.slice(0, 20));
  if (duplicated.length) console.log('重複ID一覧:', JSON.stringify(duplicated));

  const contentHash = hashObj(found);
  const output = {
    snapshotAt,
    purpose: 'v10学習対象(v9 keysUsed、6,022レース)の未加工データ受け渡し。研究・学習は行っていない。',
    note: '当時の凍結済み生データは存在しないため、現在のアーカイブから取得した新しい学習用スナップショット。「元のv10入力の復元」ではない。',
    sourceFrozenFile: 'logs/research_tree_rank_model_v9_frozen_train_2026-09-02.json (keysUsedのみ参照、内容は再利用していない)',
    targetKeyCount: targetKeys.length,
    foundCount: found.length, notFoundCount: notFound.length, duplicatedCount: duplicated.length,
    contentHash,
    notFoundKeys: notFound,
    duplicatedKeys: duplicated,
    races: found,
  };
  const outPath = path.join(ROOT, 'logs', 'research_v10_raw_train_snapshot_2026-09-02.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log('\n出力を', outPath, 'へ保存しました(新規ファイル、既存の凍結物は上書きしていません)。');
  console.log('内容ハッシュ(found配列):', contentHash);
}

if (require.main === module) main();
module.exports = { main };
