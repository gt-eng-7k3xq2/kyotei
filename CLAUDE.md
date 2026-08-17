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
| `garon_gist_sync_token` | Gist自動同期用GitHubトークン(クライアント側平文保存、`gist`スコープのみ) | gtools.html |
| `garon_gist_sync_id` | 自動同期先のPrivate Gist ID(初回同期時に自動作成・保存) | gtools.html |

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
- **解決済み(2026-08-16)**: Playwright自動収集分(`resulted:false`のまま着順・配当が未入力になる問題)は`scripts/backfill_official_results.js`で解消した。公式サイト(boatrace.jp)の結果ページ(`https://www.boatrace.jp/owpc/pc/race/raceresult?rno=X&jcd=Y&hd=Z`。会場コードは`sg_narutou.html`の`OFFICIAL_VENUE_CODE`をその場で抽出して使う。kyoteibiyori.comとは別ドメインでブロックの影響を受けない)から着順(chakuju)・3連単払戻(payout)を取得し、`resulted:true`として書き戻す。`--auto --max-days=N`で「resulted:falseが残っている過去日付を古い順にN件」自動検出でき、`scripts/run_nightly_backfill.cmd`経由でタスクスケジューラが毎晩22:15に2日分ずつ自動実行する(下記「無人運用インフラ」参照)。**既知の制約**: 全艇フライング等で「レース不成立」(公式サイト側にも着順が存在しない)のレースは`resulted:false`のまま残り続ける。バグではなく実データの制約(2026-08-07大村1R・2026-08-08戸田8Rで確認済み)。自動検出は日付ベースのため、こうした恒久的に解決不能な日は毎晩再試行され続ける(無害だが数秒分の無駄なリクエストが発生する)。
- `scripts/collect_batch.js` — 複数日をまとめて連続実行するバッチスクリプト。1日ごとに`collect_playwright.js`を`--date`違いで順次呼び出し、ある日が失敗しても止まらず次の日へ進む。最後に日ごとのサマリー(追加/スキップ/失敗件数)を一覧表示する。
- `scripts/lib/browser-scan.browser.js` — ブックマークレットのスキャン関数群をほぼそのまま移植したブラウザコンテキスト側スクリプト。`context.addInitScript()`で毎回のページ遷移時に自動注入される
- `scripts/lib/extract-parse-data.js` — **daikibo_archive.html**から`parseData`/`parseMotorHistory`/`extractOddsMap`を直接抜き出して実行するヘルパー(tests/lib/extract-score-engine.jsと同じ「本体を毎回読みに行く」方式)。sg_narutou.html側のparseData()ではなくdaikibo_archive.html側を使う理由: 実際のアーカイブのoddsMap/motorHistoryはdaikibo_archive.html独自のparseData()(末尾でparseMotorHistory()/extractOddsMap()を呼ぶ)で作られているため
- **既知の制約**: daikibo_archive.html側のparseData()は開催日目・レース種別(day/raceCategory)をメタ行から読み取っていない。収集スクリプト側でどれだけ正確に収集しても、この値はアーカイブJSONには保存されない(既存の手動運用と同じ挙動を踏襲)

## 無人運用インフラ(2026-08-16〜)

Windowsタスクスケジューラに13タスク(日次9・週次1・オンデマンド専用2)を登録している(`scripts/setup_scheduled_tasks.ps1`で再登録・設定変更可能。冪等)。あわせてスリープ・休止状態はAC/バッテリー両方で恒久的に無効化済み(`powercfg /change standby-timeout-* 0` / `hibernate-timeout-* 0`)、Windows Updateのアクティブ時間は7:00〜22:00に固定済み(稼働時間帯中の強制再起動を防止)。

**2026-08-17更新: 全タスクをS4Uログオン方式に変更**。従来のInteractiveToken(対話ログオン必須)だと、毎晩の自動再起動(`GARON_NightlyReboot`)後に誰もサインインしない限りどのタスクも動かなくなってしまうため、パスワード保存不要で「サインインの有無を問わず実行」できるS4Uに切り替えた(自動サインオン設定は不使用)。`GARON_NightlyReboot`本体と、オンデマンド専用の`GARON_EmergencyStop`/`GARON_ResumeAutomation`はRunLevel=Highest(shutdown /rやタスク無効化に管理者権限が要るため、登録時点で昇格を確定させ、実行時にUACを出さない設計)。

| タスク名 | 起動時刻 | 実行スクリプト | 内容 |
|---|---|---|---|
| `GARON_RealtimeScreening` | 毎日8:00(2026-08-16、モーニング開催の1R締切8:32等に対応するため10:00→8:00に変更) | `scripts/realtime_screening.js`(`run_realtime_screening.cmd`経由) | T-10到達レースの抽出・参入判定・ntfy通知。稼働時間帯(8時台〜21時台)を過ぎるとプロセス自身が日次サマリー通知を送って終了する(タスクスケジューラは起動と失敗時再起動〈2分間隔・最大999回〉のみ担当)。抽出/判定が連続5件失敗するとntfyで異常アラートを送る(ただしkyoteibiyori.comへのスケジュール取得自体が失敗するケースはこのアラート対象外。サイトブロック監視は`GARON_SiteBlockMonitor`が別途担当)。判定結果は`logs/race_judgments_YYYY-MM-DD.json`に構造化保存する(`GARON_DraftSkipReason`が読む)。**2026-08-17追加**: `GARON_SiteBlockMonitor`が書く`logs/.site_block_state.json`を毎ループ読み、ブロック中(かつ直近20分以内に確認済み=状態が新しい)と分かっている間はkyoteibiyori.comへの実リクエスト自体をスキップして待機する。状態が無い/壊れている/20分以上古い(監視タスク停止の疑い)場合は信用せず通常通り自分でポーリングを試みる(安全側に倒す設計)。ブロック解除検知後は次のループ(最大4分後)で自動的に通常監視を再開する。 |
| `GARON_DraftSkipReason` | 毎日22:05(realtime_screening終了直後) | `scripts/draft_skip_reason.js`(`run_draft_skip_reason.cmd`経由) | その日1件も参戦しなかった(評価はしたが全件見送り)場合のみ、見送り理由の内訳(僅差/推定ROI不足の件数)をまとめた投稿下書き`reports/skip_reason_YYYY-MM-DD.md`を生成。文面はsg_narutou.htmlのX投稿の流儀(「G.」署名)に合わせた下書きであり、投稿前に必ず内容を確認すること。 |
| `GARON_NightlyBackfill` | 毎日22:15 | `scripts/backfill_official_results.js --auto --write`(`run_nightly_backfill.cmd`経由) | `daikibo_archive`の`resulted:false`が残っている過去日付を古い順に2日分ずつ自動バックフィル。 |
| `GARON_NightlyDiagnosis` | 毎日22:45 | `scripts/fetch_gist_log.js`→`scripts/nightly_diagnosis.js`(`run_nightly_diagnosis.cmd`経由) | 本体の前に`scripts/fetch_gist_log.js`を実行し、gtools実績ログ(下記「gtools実績ログのGist自動同期」参照)を`logs/gtools_actual_log.json`へ取得(未設定なら黙ってスキップ、診断本体は止めない)。`tests/weighted_optimization_search.js`の計算ロジック(3,000円均等回収配分・held-out検証)を再利用し、sg_narutou.htmlから動的取得した現行本番閾値の全期間/held-out成績を前回スナップショット(`reports/.diagnosis_snapshot.json`)と比較。純損益の黒字/赤字反転・ROIが2pt以上変動・本番閾値変更・前回レポートから7日以上経過のいずれかに該当した時だけ`reports/proposal_YYYY-MM-DD.md`を生成する。レポート生成時は`scripts/motor_correlation_analysis.js`(下記)のモーター成績相関セクションと、gtools実績データとの比較セクションも自動的に含める。 |
| `GARON_UpdateDashboard` | 毎日22:50 | `scripts/update_dashboard.js`(`run_update_dashboard.cmd`経由) | 現行本番閾値での「実際に参入していたら」の日別収支を累積し、`reports/dashboard.html`(累積純損益・累積的中率の推移グラフ、vanilla JS・外部フレームワーク不使用の静的HTML)を毎晩無条件で更新する。 |
| `GARON_DataQualityScan` | 毎日23:00(バックフィル後) | `scripts/data_quality_scan.js`(`run_data_quality_scan.cmd`経由) | `daikibo_archive`全体を既知パターンでスキャン(boats欠損/`isJogai`による欠場検知/oddsMap不足/resulted不整合/3日以上未バックフィル放置/重複エントリ)。検出時のみ`reports/data_quality_YYYY-MM-DD.md`を生成しntfy通知。**注意**: 展示タイム・直前STが0という条件だけでは欠場を判定しない(2026-08-16調査で全体の約24%が該当する誤検知だらけの指標と判明したため)。データに既にある`isJogai`フラグを直接見る。 |
| `GARON_ArchiveBackup` | 毎日23:15 | `scripts/backup_archive.js`(`run_backup_archive.cmd`経由) | `daikibo_archive_*.json`を`C:\garon_backup\daikibo_archive\`へミラーコピー(差分のみ)。物理的な別ドライブが無いため、C内の別フォルダを保存先としている(2026-08-16、雄大さん了承済み。誤削除・誤上書き対策であり、Cドライブ自体の障害には非対応)。 |
| `GARON_NightlyGitCommit` | 毎日23:30(最後) | `scripts/nightly_git_commit.js`(`run_nightly_git_commit.cmd`経由) | CLAUDE.md・`tests/`・6つのHTMLツール(スペース区切りへリネーム)を`C:\garon\gt-eng-7k3xq2`へコピーし、変更があればそのリポジトリでローカルcommitのみ行う(pushは一切しない。手動で確認してからpushする運用を維持)。`scripts/`はリポジトリに存在しないため同期対象外(追加するかは別途判断)。リポジトリのgit設定は2026-08-16よりローカルで`user.name=GARON`に変更済み(以前の履歴書き換えと整合させるため)。 |
| `GARON_NightlyReboot` | 毎日03:00(git commitの後、翌8:00のRealtimeScreeningまで十分な余裕を確保) | `scripts/run_nightly_reboot.cmd`(`shutdown /r /t 60`) | 24時間稼働の安定性のためPCを毎晩自動再起動する(2026-08-17追加)。S4Uログオンのため、再起動後に誰もサインインしなくても他の全タスクは通常通り動く。`GARON_SiteBlockMonitor`のダウンタイムは再起動所要時間(数分程度)のみ。 |
| `GARON_SiteBlockMonitor` | 毎日0:05から15分間隔で終日反復 | `scripts/monitor_site_block.js`(`run_site_block_monitor.cmd`経由) | kyoteibiyori.comへの軽量な疎通確認(realtime_screening.jsと同じAPIエンドポイント)。状態は`logs/.site_block_state.json`に保存し、「ブロック中→到達可能」に変化した瞬間だけntfy通知する(逆方向は通知せずログのみ)。稼働時間帯に縛られず終日動くため、夜間にブロックが解けても気づける。 |
| `GARON_NtfyHealthCheck` | 毎週月曜7:30(週次、8:00の稼働開始前) | `scripts/ntfy_health_check.js`(`run_ntfy_health_check.cmd`経由) | ntfy疎通確認専用の軽量テスト通知を1件送るだけ(2026-08-17追加)。トピック誤設定・ntfy.sh側の障害・スマホ側の購読解除などを、実際のレース判断に影響する前に検知する目的。 |

各タスクのログは`C:\garon\logs\`配下(タスク名に対応する`*.log`、追記式)。

**オンデマンド専用タスク(トリガー無し。デスクトップショートカットから起動、2026-08-17追加)**:

| タスク名 | 起動方法 | 内容 |
|---|---|---|
| `GARON_EmergencyStop` | デスクトップの`GARON_緊急停止.lnk`をダブルクリック(`schtasks /run /tn GARON_EmergencyStop`) | `GARON_*`全13タスクを無効化(削除ではない)し、`C:\garon\scripts`配下のnode.exeプロセスを終了する。`scripts/emergency_stop.ps1`。 |
| `GARON_ResumeAutomation` | デスクトップの`GARON_再開.lnk`をダブルクリック(`schtasks /run /tn GARON_ResumeAutomation`) | 全タスクを再有効化し、`GARON_SiteBlockMonitor`を即時起動(稼働時間帯内なら`GARON_RealtimeScreening`も即時起動)。`scripts/resume_automation.ps1`。 |

## gtools実績ログのGist自動同期(2026-08-17〜)

gtools.htmlの予想ログ(`kyotei_v2`)は日々iPhoneのブラウザlocalStorageに溜まるため、PC側のClaude Codeから直接読めない(手動エクスポート&貼り付けが必要だった)問題への対応。

- **gtools.html側**: `saveLogs()`(ログの追加・編集・削除・配当反映が全て経由する唯一の書き込み関数)にフックを追加し、書き込みのたびに2.5秒デバウンスで非公開(`public:false`)Gistへ自動アップロードする(`scripts/gtools.html`内、`doGistSync()`)。初回は新規Gist作成、以降は同じGist IDへPATCHで上書き。トークン未設定時は何もしない(既存動作に影響なし)。設定は「ログ」タブ内のカードから、GitHubトークン(`gist`スコープのclassic PAT。**fine-grained PATはGist未対応のため使えない**)を貼り付けるだけ。
- **PC側**: `scripts/fetch_gist_log.js`が`.env`の`GITHUB_GIST_TOKEN`/`GITHUB_GIST_ID`を使ってGistを取得し、`logs/gtools_actual_log.json`へ保存。`GARON_NightlyDiagnosis`(22:45)の直前に実行され、`reports/proposal_*.md`と`reports/dashboard.html`の両方に「実績データ(gtoolsの実際の記録)」セクション/タイルとして反映される(`scripts/lib/gtools_actual.js`が集計ロジックを共有)。**シミュレーション(閾値ベースの機械的な参入判定)と実績(実際の記録)は別集計として並べて表示**しており、どちらかに一本化するかは実績データが十分溜まってから判断する。gtools同期データには賭け金(単価)情報が含まれないため、正確なROI/純損益は計算せず、件数・的中率・的中時配当合計の比較にとどめている。
- **トークンは用途別に2本発行**(同じトークンを使い回さない): iPhone用(書き込み、gtools.html内`localStorage`保存)とPC用(読み取り、`.env`の`GITHUB_GIST_TOKEN`)。どちらも`kyotei_gemini_key`/`NTFY_TOPIC`と同じ既存の信頼モデル(クライアント側平文 / `.gitignore`済み`.env`)を踏襲している。
- **セットアップ未完了(2026-08-17時点)**: 上記2本のトークン発行・貼り付けはまだ行われていない。`fetch_gist_log.js`は`.env`にキーが無い間は黙ってスキップし続けるので、診断・ダッシュボード生成自体は壊れない。

**モーター成績相関分析(`scripts/motor_correlation_analysis.js`)の制約(2026-08-16確認)**: 生の「モーター履歴」(`motorHistory`、レースごとの時系列)は全5,973レース中1件しか取得できておらず使用不可。代わりに艇ごとのモーター成績統計(`motorRank`/`motor2ren`/`motorContribP`、全体の約98%で値あり)を使う。SG/G1等のレース格式(`grade`/`raceCategory`)はアーカイブのスキーマに存在せず、級別の絞り込みは現状不可能(将来収集パイプライン側を拡張すれば対応可能)。

**セッション開始時の提示ルール**: 下記「理想スケジュールとフェーズ移行」の「新セッション開始時のチェック順序」に統合した。そちらを参照。

## 理想スケジュールとフェーズ移行(2026-08-17〜)

GARONは「無人稼働インフラの完成度」と「実際に予想を出す・当たる」が別軸で進む。インフラがどのフェーズにあっても、日々の予想作成・投稿(下記「原則」参照)は独立して継続する。

### フェーズ定義

| フェーズ | 内容 | 状態(2026-08-17時点) |
|---|---|---|
| 1: 基盤構築 | 無人運用インフラ全13タスクの登録・S4Uログオン化・深夜自動再起動・Windows Updateアクティブ時間・緊急停止/再開・ntfy疎通週次チェック | 完了 |
| 2: ブロック待機 | kyoteibiyori.comのブロック継続中。インフラは稼働しているが新規データ収集・実質的なリアルタイム参入判定ができない | **現在ここ**(2026-08-16 22:36〜継続中。`GARON_SiteBlockMonitor`が15分間隔で監視) |
| 3: 実機検証 | ブロック解除後、下記4ステップを順に実施 | 未着手 |
| 4: 本格採用 | シャドーモードの実績を確認した上で、リアルタイム参入判定を正式な参戦判断として採用 | 未着手 |

### フェーズ2→3移行手順(ブロック解除がトリガー)

ブロックが解除されたら、前のステップが終わってから次へ、の順で進める。

1. **バックフィル完了** — `daikibo_archive_*.json`のresulted:false件数が0になるまで`GARON_NightlyBackfill`(毎晩22:15、2日分ずつ)を待つ。2026-08-17時点で8/9(105レース)・8/15(3レース)分が未消化、8/10〜8/14・8/16以降はブロックのため収集自体が未実施。
2. **閾値91再検証** — `GARON_NightlyDiagnosis`が生成する`reports/proposal_*.md`で、バックフィル完了後の完全なデータに基づくROI>=91閾値のheld-out検証を再確認する。ブロック中の空白期間(8/10〜8/14等)でデータが偏っていないか要確認。
3. **リアルタイムスクリーニング実機テスト** — ブロック解除後、`GARON_RealtimeScreening`が実際に当日レースを取得・判定できているか(`logs/realtime_screening.log`で判定件数>0、ブロックスキップ以外のログが出ているか)を確認する。
4. **シャドーモード期間** — 判定結果は記録するが実際の参戦判断には使わず、後から答え合わせする期間を置く。厳守ルール3(n<30は信用しない)と同じ基準で、**n>=30件**(できればn=60〜80)蓄積するまで継続する。

### フェーズ3→4移行条件

シャドーモードで蓄積したn>=30件の判定成績が、閾値の想定(ROI>=91水準)から大きく外れていないことを確認できたら、リアルタイム参入判定の出力を正式な参戦判断として採用する(フェーズ4)。乖離が大きい場合はフェーズ3に留まり、閾値・ロジックを見直す。

### 新セッション開始時のチェック順序

新しいセッションを開始したら、本題に入る前に以下の順で確認し、要点(あれば)と「現在フェーズ・次にすべきこと」を一度提示する。

1. **提案レポート等** — `reports/`内の`proposal_*.md`・`data_quality_*.md`・`skip_reason_*.md`のうち、`reports/.last_presented`(日付文字列のみのマーカーファイル。無ければ「まだ何も提示していない」扱い)の日付より新しいものが無いか確認。あれば要点を提示し、`reports/.last_presented`をその日付で更新する。
2. **ブロック状況** — `logs/.site_block_state.json`の`blocked`/`since`/`lastCheckedAt`を確認する。
3. **ダッシュボード** — `reports/dashboard.html`の最終更新日時・累計参戦件数・的中率・ROI・純損益を確認する。
4. **現在フェーズの判定と提示** — 上記の結果を踏まえ、上記フェーズ定義のどこにいるか(基本的にはブロック状況で2↔3を判定)を一言で示し、次にすべきことを一言添える。その後で本題に入る。

### 原則: 開発作業と実際の予想発信は別物

無人稼働インフラがどのフェーズにあっても(たとえフェーズ2でブロックが続き自動化が実質止まっていても)、雄大さんの**日々のiPhoneでの予想作成・X投稿は普段通り継続する**。sg_narutou.htmlを手動で使う既存フローは本自動化インフラの外側にあり、依存関係が無い。自動化はあくまで「将来的に検証を厚くする・省力化する」ための並行トラックであり、その進捗状況を理由に日々の予想発信を止めない。

## GitHubリポジトリ

`https://github.com/gt-eng-7k3xq2/kyotei` (GitHub Pagesで公開) と連携している。ローカルの`C:\garon`とは別の場所(`C:\garon\gt-eng-7k3xq2`)にcloneして運用しており、`C:\garon`自体はgit管理下ではない。

- リポジトリ側のファイル名は**スペース区切り**(例: `sg narutou.html`)。ローカルはアンダースコア区切り(`sg_narutou.html`)なので、push前に名前を対応させて手動コピーする必要がある(自動リネームの仕組みは無い)。
- `daikibo_archive_*.json`(実データ)はリポジトリに含めない(`.gitignore`で除外)。GitHub Pagesは公開サイトのため、生のレースデータを載せない方針。
- `tests/`・`CLAUDE.md`はリポジトリにも含める。

## 厳守ルール

1. **実装前に必ずユーザーに確認を取ること。** 提案・合意なしにコードの変更を書き始めない。
2. **修正後は必ず`node --check`で構文確認すること。** 上記の方法で`<script>`内容を抽出してから実行する。これらは単一HTMLファイルの実運用ツールであり、構文エラーが1つでも入るとファイル全体が読み込み不能になり、本番ツールが即座に使えなくなる。
3. **n<30のサンプルは信用しないこと。** バックテスト・検証結果でサンプル数(n)が30未満の集計は「傾向」として扱わず、結論の根拠にしない。既存コード内でもn=60〜80を「傾向として信頼できる目安」としている箇所がある(gtools.html, kyotei_backtest.html)。それより緩い閾値で判断を確定させない。
