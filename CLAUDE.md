# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

GARONは競艇(ボートレース)の予想・検証を行うツール群。ビルドプロセス・パッケージマネージャは存在せず、独立したHTML単一ファイル(vanilla JS + インラインCSS、外部フレームワーク不使用)で構成される。各ファイルはブラウザで直接開いて使う。

## ファイル構成と役割

- **sg_narutou.html** — 本番予想エンジン。BM抽出データを貼り付けてスコア計算・モード判定・買い目生成・X投稿文生成までを行う。Gemini API (`generativelanguage.googleapis.com`) を呼び出して展開コメントを生成する。
- **gtools.html** — 集計・分析ツール集。取込/分析/ログ/日報/朝投稿/的中画像などの複数タブを1ファイルに束ねたSPA。sg_narutou.htmlと同じ`localStorage`キー(`kyotei_v2`)を共有し、ベット記録・的中ログを読み書きする。
- **kyotei_backtest.html** — 夜間検証エンジン。終了レースの答え合わせ専用。本番(sg_narutou/gtools)とは完全に独立した`localStorage`キー(`kyotei_backtest_v1`)を使い、週間報告・的中率集計には一切混ざらない。プロンプトやスコア配分の検証用。
- **daikibo_archive.html** — 大規模検証アーカイブ。艇ごとの逃げ率・モーター・展示・直線・直前STなどの生データと結果をIndexedDB(`daikibo_archive_db`)にそのまま保存する専用ツール。スコア計算・モード判定・買い目生成は一切行わない(判定ロジックが変わっても過去データをそのまま再利用できるようにするための保管庫)。
- **daikibo_replay.html** — リプレイ検証。daikibo_archive.htmlでエクスポートしたJSONを読み込み、「今この瞬間の最新ロジック」(`calcAreScore`/`calcAreIndex`/`judgeMode`/`buildBetsProbabilistic`)を全件に通して的中率・ROIを一括再計算する。
- **garon_gist_uploader.html** — 補助ツール。貼り付けたデータをGitHub Gistにアップロードし、Claudeとの会話にはURLだけ渡せるようにする(大きいデータをチャットに直接貼らずに済ませるため)。スコアロジックとは無関係で同期対象外。GitHubリポジトリ側では`garon gist uploader.html`(スペース区切り)という名前で置かれている。

## 重要アーキテクチャ: スコアロジックの手動複製

スコア計算・判定ロジック(`calcAreScore`, `calcAreIndex`, `judgeMode`, `buildBetsProbabilistic`, `parseData` など)は共通モジュール化されておらず、必要なファイルごとにコピー&ペーストで複製されている。買い目生成は`buildBetsProbabilistic`(確率ベース)に一本化されており、`buildBetsNigeNashi`は過去ログ互換確認用に残っているだけの未使用コード。

- `SCORE_ENGINE_VERSION`定数(現在5)が **sg_narutou.html / gtools.html / kyotei_backtest.html / daikibo_replay.html** の4ファイルにそれぞれ独立して定義されている。
- daikibo_archive.html / daikibo_replay.html のスクリプト冒頭には「kyotei_backtest.htmlから流用（改変なし。必ず同期させること）」という明示コメントがある。
- ロジックを変更する場合は、影響する全ファイルに同じ変更を手動で反映し、`SCORE_ENGINE_VERSION`をインクリメントすること。1ファイルだけ直して終わりにしない。どのファイルが同期対象かは変更前に確認する。
- `tests/score_engine.regression.test.js`(下記参照)がsg_narutou.htmlから対象関数を毎回読み込んで実行するため、ロジック変更後は必ずこれも実行して意図した差分だけになっているか確認する。

## ストレージキー(localStorage / IndexedDB)

系統ごとにストレージが分離されている。新しいキーを追加するときは、どの系統のデータかを意識し、系統をまたいで混ざらないようにする。

| キー | 用途 | 使用ファイル |
|---|---|---|
| `kyotei_v2` | 本番のベット・結果ログ本体 | sg_narutou.html, gtools.html(共有) |
| `kyotei_gemini_key` | Gemini APIキー(クライアント側平文保存) | sg_narutou.html, gtools.html |
| `sg_venue` / `sg_racenum` / `sg_raceType` | 入力フォームの直近値保持 | sg_narutou.html |
| `kyotei_backtest_v1` | 夜間検証エンジン専用ログ(本番とは別領域) | kyotei_backtest.html |
| `daikibo_archive_db` (IndexedDB) | 大規模アーカイブの生データ保存先 | daikibo_archive.html |

## 開発コマンド

ビルド・lintの仕組みは無い。

- **動作確認**: 対象のHTMLファイルをブラウザで直接開く(ローカルファイル、または`npx serve .`等の簡易サーバー)。
- **構文確認**: JSは`<script>`タグ内にHTMLと混在しているため、`node --check`をHTMLファイルに直接実行することはできない。`<script>`内容を一時ファイルへ抜き出してから確認する。例:
  ```
  node -e "const fs=require('fs');const html=fs.readFileSync('sg_narutou.html','utf8');const m=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];fs.writeFileSync('_check.js', m.map(x=>x[1]).join('\n;\n'));"
  node --check _check.js
  ```
- **回帰テスト**: `node tests/score_engine.regression.test.js` — sg_narutou.htmlから`calcAreScore`/`calcAreIndex`/`judgeMode`/`buildBetsProbabilistic`等を直接抜き出して実行し、実際のレースデータ(三国9R・平和島12R、`tests/fixtures/`)に対する出力を`tests/golden/`のゴールデン値と比較する。ロジックを意図的に変更した後は`--update-golden`でゴールデン値を更新すること。`parseData()`はテスト対象外(理由はテストファイル冒頭のコメント参照)。

## GitHubリポジトリ

`https://github.com/gt-eng-7k3xq2/kyotei` (GitHub Pagesで公開) と連携している。ローカルの`C:\garon`とは別の場所(`C:\garon\gt-eng-7k3xq2`)にcloneして運用しており、`C:\garon`自体はgit管理下ではない。

- リポジトリ側のファイル名は**スペース区切り**(例: `sg narutou.html`)。ローカルはアンダースコア区切り(`sg_narutou.html`)なので、push前に名前を対応させて手動コピーする必要がある(自動リネームの仕組みは無い)。
- `daikibo_archive_*.json`(実データ)はリポジトリに含めない(`.gitignore`で除外)。GitHub Pagesは公開サイトのため、生のレースデータを載せない方針。
- `tests/`・`CLAUDE.md`はリポジトリにも含める。

## 厳守ルール

1. **実装前に必ずユーザーに確認を取ること。** 提案・合意なしにコードの変更を書き始めない。
2. **修正後は必ず`node --check`で構文確認すること。** 上記の方法で`<script>`内容を抽出してから実行する。これらは単一HTMLファイルの実運用ツールであり、構文エラーが1つでも入るとファイル全体が読み込み不能になり、本番ツールが即座に使えなくなる。
3. **n<30のサンプルは信用しないこと。** バックテスト・検証結果でサンプル数(n)が30未満の集計は「傾向」として扱わず、結論の根拠にしない。既存コード内でもn=60〜80を「傾向として信頼できる目安」としている箇所がある(gtools.html, kyotei_backtest.html)。それより緩い閾値で判断を確定させない。
