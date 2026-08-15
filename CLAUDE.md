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

## データ収集(scripts/)

`scripts/collect_playwright.js` — kyoteibiyori.comのBMデータを半自動収集するPlaywrightスクリプト。元は`garon_multiwin_full_auto.txt`というブックマークレット(iPhone Safari用)で、そのDOM操作ロジックを移植したもの。完全無人のスケジュール実行ではなく、ターミナルからコマンドを1つ叩いて実行する運用。

- `npm install` (playwrightがこのプロジェクト初のnpm依存。`package.json`/`node_modules`が生成される)
- `npx playwright install chromium` (初回のみ、ブラウザバイナリのダウンロード)
- 実行例: `node scripts/collect_playwright.js --venue=桐生 --races=3`(小規模テスト用。`--venue`省略で全会場、`--races`省略で12R全部)
- `--motor`でモーター履歴収集(最も重い処理)をオプトインで追加、`--headless`で画面非表示実行
- `--date=YYYYMMDD`で過去日付の収集も可能(`--venue`省略で全会場を自動検出)。2026-08-15確認: race_shusso.phpは過去日付でも基本情報/枠別勝率/今節成績/直前情報/モータ情報/STズレ/オッズが当時のまま全て残っている。会場一覧は`schedule/kaisai_today.php`が内部で叩いているAJAX API(`schedule/request_kaisak_ctrl.php`、POST `data={"hiduke":"YYYYMMDD","place_no":0,"sort_select":0}`)を直接呼んで取得しており、トップページのHTML抽出(今日専用)と並ぶ2つ目の会場検出経路になっている(今日分で両方式の結果が完全一致することを確認済み)
- 保存先は`daikibo_archive_YYYY-MM-DD.json`(既存の手動収集と同一フォーマット)。同日ファイルが既にある場合、会場+レース番号が重複するレースは自動スキップ(再開安全)
- **既知の制限**: 「欠場選手あり」レースは、展示タイム・直前STが0のまま取得されることがある(2026-08-15確認、平和島9R・住之江10Rで再現)。欠場によりページのタブ構造が通常と異なり、`browser-scan.browser.js`のキーワード一致スキャンが対応できていないため。同じレースを再収集しても直らない(タイミングの問題ではなく構造的な問題)。oddsMapの件数が通常の120通りより少ない(欠場艇の分、組み合わせが減る)ことがこのケースの目印になる。
- **既知の課題**: `daikibo_archive_2026-08-04.json`〜`08-08.json`(Playwrightで自動収集した分)は`resulted:false`のまま、着順(chakuju)・配当(payout)が未入力。手動収集(daikibo_archive.html経由)と違い、結果を後から入力する工程がまだ無いため、的中率・ROIを使うバックテスト(entry_criteria_diagnosis.js等)では現状これらの日付を除外している。結果を後付けする方法の候補(2026-08-15調査、未実装・未検証。kyoteibiyori.comブロック中のため実機確認できず):
  - **方法A(推奨)**: 公式サイト(boatrace.jp)の結果ページを使う。`sg_narutou.html`の`OFFICIAL_VENUE_CODE`(会場→場コード表)と`openOfficialRaceList()`が使っている出走表URL(`https://www.boatrace.jp/owpc/pc/race/racelist?rno=X&jcd=Y&hd=Z`)と同じパラメータ形式で、結果ページ(`raceresult`)が存在するはずだが未確認。
  - **方法B**: kyoteibiyori.com自体の`race_shusso.php`にある「結果」「出目ランク」タブ(過去日付ページに存在することは確認済み)を`browser-scan.browser.js`と同じ方式でスキャンする。
- `scripts/collect_batch.js` — 複数日をまとめて連続実行するバッチスクリプト。1日ごとに`collect_playwright.js`を`--date`違いで順次呼び出し、ある日が失敗しても止まらず次の日へ進む。最後に日ごとのサマリー(追加/スキップ/失敗件数)を一覧表示する。
- `scripts/lib/browser-scan.browser.js` — ブックマークレットのスキャン関数群をほぼそのまま移植したブラウザコンテキスト側スクリプト。`context.addInitScript()`で毎回のページ遷移時に自動注入される
- `scripts/lib/extract-parse-data.js` — **daikibo_archive.html**から`parseData`/`parseMotorHistory`/`extractOddsMap`を直接抜き出して実行するヘルパー(tests/lib/extract-score-engine.jsと同じ「本体を毎回読みに行く」方式)。sg_narutou.html側のparseData()ではなくdaikibo_archive.html側を使う理由: 実際のアーカイブのoddsMap/motorHistoryはdaikibo_archive.html独自のparseData()(末尾でparseMotorHistory()/extractOddsMap()を呼ぶ)で作られているため
- **既知の制約**: daikibo_archive.html側のparseData()は開催日目・レース種別(day/raceCategory)をメタ行から読み取っていない。収集スクリプト側でどれだけ正確に収集しても、この値はアーカイブJSONには保存されない(既存の手動運用と同じ挙動を踏襲)

## GitHubリポジトリ

`https://github.com/gt-eng-7k3xq2/kyotei` (GitHub Pagesで公開) と連携している。ローカルの`C:\garon`とは別の場所(`C:\garon\gt-eng-7k3xq2`)にcloneして運用しており、`C:\garon`自体はgit管理下ではない。

- リポジトリ側のファイル名は**スペース区切り**(例: `sg narutou.html`)。ローカルはアンダースコア区切り(`sg_narutou.html`)なので、push前に名前を対応させて手動コピーする必要がある(自動リネームの仕組みは無い)。
- `daikibo_archive_*.json`(実データ)はリポジトリに含めない(`.gitignore`で除外)。GitHub Pagesは公開サイトのため、生のレースデータを載せない方針。
- `tests/`・`CLAUDE.md`はリポジトリにも含める。

## 厳守ルール

1. **実装前に必ずユーザーに確認を取ること。** 提案・合意なしにコードの変更を書き始めない。
2. **修正後は必ず`node --check`で構文確認すること。** 上記の方法で`<script>`内容を抽出してから実行する。これらは単一HTMLファイルの実運用ツールであり、構文エラーが1つでも入るとファイル全体が読み込み不能になり、本番ツールが即座に使えなくなる。
3. **n<30のサンプルは信用しないこと。** バックテスト・検証結果でサンプル数(n)が30未満の集計は「傾向」として扱わず、結論の根拠にしない。既存コード内でもn=60〜80を「傾向として信頼できる目安」としている箇所がある(gtools.html, kyotei_backtest.html)。それより緩い閾値で判断を確定させない。
