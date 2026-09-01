'use strict';
// 展示欠損0秒問題の研究用最小修正(2026-09-01、CEO承認)。
// tenji/syukai/syukaiFoot/chokusenの4項目について、有限の正の時間だけを計測値として扱う。
// 0・null・未定義・非数値・負数はrankOf()に渡す前にnullへ変換し、既存の正規の欠損処理経路
// (rankOf内の`v!=null`フィルタ、exhibitAvgRankの「有効な項目だけ平均・0件ならnull」)を
// そのまま再利用する(4項目全てが必要という条件は追加しない、一部欠損はそのまま平均に含める)。
// 原本のgaron_q_engine.htmlは一切変更せず、一時ファイルへの複製後にこの1箇所だけを置換する。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadQEngine } = require('./extract-q-engine.js');

const TARGET_LINE = "const exhibitionMetrics=[b=>b.tenji, b=>b.syukai, b=>b.syukaiFoot, b=>b.chokusen];";
const REPLACEMENT_LINE = [
  "const _validExhibitTime=v=>(typeof v==='number' && isFinite(v) && v>0) ? v : null;",
  "const exhibitionMetrics=[b=>_validExhibitTime(b.tenji), b=>_validExhibitTime(b.syukai), b=>_validExhibitTime(b.syukaiFoot), b=>_validExhibitTime(b.chokusen)];",
].join('\n');

// htmlPath(通常はgaron_q_engine.htmlの本番パス)を読み取り専用で読み、修正版の一時ファイルを
// 作って loadQEngine() する。本番ファイルには一切書き込まない。
function loadFixedQEngine(htmlPath) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const occurrences = source.split(TARGET_LINE).length - 1;
  if (occurrences !== 1) throw new Error(`想定外: TARGET_LINEの出現回数=${occurrences}(1のはず)。原本の該当行が変更された可能性があります。`);
  const patched = source.replace(TARGET_LINE, REPLACEMENT_LINE);
  const tmpPath = path.join(os.tmpdir(), `garon_q_engine_exhibit_fix_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmpPath, patched);
  const engine = loadQEngine(tmpPath);
  fs.unlinkSync(tmpPath); // 抽出後は一時ファイル自体も削除(loadQEngineはrequire時点で内容を読み込み済み)
  return engine;
}

module.exports = { loadFixedQEngine, TARGET_LINE, REPLACEMENT_LINE };
