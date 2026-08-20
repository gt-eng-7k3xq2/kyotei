# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

GARONは競艇(ボートレース)の予想・検証を行うツール群。ビルドプロセス・パッケージマネージャは存在せず、独立したHTML単一ファイル(vanilla JS + インラインCSS、外部フレームワーク不使用)で構成される。各ファイルはブラウザで直接開いて使う。

## GARON COMPANY構想(北極星、2026-08-18〜)

将来的にGARONを「人間1人＋複数の専門AI・決定的コードによって運営されるAIネイティブな個人会社」へ発展させる構想がある。**今すぐ全組織・全Agentを実装するものではなく、今後の開発判断の指針(北極星)として保持する。**

**構想の全文(26セクション、CEO/Data/Prediction/Research/Devil/Audit/System/Content/Marketingの各部門の役割・権限・意思決定フロー等)は[GARON_COMPANY_VISION.md](GARON_COMPANY_VISION.md)を参照。** 以下は要点のみ。

**最重要の設計思想**:
1. **リアルタイム経路(データ取得→GARON判定→参入/見送り→ntfy通知)には原則としてLLMを入れない。** 決定的コード・ルールベースで高速・再現性を維持する。「AIを使う必要がない場所にAIを使わない」。
2. AIは創造的・分析的な仕事(Research・新しい仮説の発見・改善案の提案・展開コメント生成・SNS企画・開発支援等)に使う。
3. 本番環境と研究・開発環境は分離する。Research→Proposal→Backtest→Development→Testing→Audit→Human Approval→Productionの流れを目指す。
4. **バックテストと本番ロジックの一致を最重要事項の一つとする。** 「同じデータなら同じルール・同じ判定結果になる」再現性を重視する(2026-08-18のdaikibo_replay.html v5放置発覚は、まさにこの原則が守られていなかった実例)。
5. AI同士が無条件に肯定し合わない構造(Devil/Opponent役)を将来的に検討するが、今は独立AIとして実装しない。

**現在の優先順位**: ①予想精度・収益性の確立 ②リアルタイムスクリーニングの安定運用 ③バックテストと本番ロジックの完全一致 ④Auditの強化。

**具体的な目標数値(2026-08-19、雄大さんより明示)**: ①的中率の最大化 ②回収率の最大化 ③SNS運用での露出 ④Xフォロワー数の爆増 ⑤note記事販売のコンスタント月6万円。組織を大きくすること自体が目的ではなく、これらの最終目標達成のために「各部署からの提案を自動的にどんどん出してもらい、トライアンドエラーを繰り返す」ことが構想の実務的な狙いである。ただし闇雲な拡大は避け、段階的に検証しながら広げる(既存の優先順位・n<30を信用しないルール等と矛盾しない範囲で)。

**重要な誤解の訂正(2026-08-19)**: 「1日の参入数が少なすぎてSNS露出が下がる」という懸念に対し、閾値を緩めると的中率・ROIが下がる(閾値91: 6.7件/日・ROI99.1% → 閾値88: 19.1件/日・ROI89.5%)というトレードオフを提示したところ、CEOから「それは今のスコアリング・買い目構成の実力の話であって、**そのスコアリング自体を改善し、閾値を緩めても質を落とさず件数を増やせるようにするのが各部隊(特にRESEARCH)の本来の仕事**」という重要な訂正があった。今後の研究部隊の仕事は、既存スコアに後からフィルタをかける分析(gap帯・motor2ren等の絞り込み)に留まらず、**calcAreScore/buildBetsProbabilistic自体の改良(新しい特徴量の発見、重み付けの見直し等)によって「閾値を緩めても質を維持できる」状態を目指すこと**を上位目標とする。閾値と的中率/ROIのトレードオフは所与の制約ではなく、改善によって動かすべき対象。

**2026-08-19、構想の第一歩として実装開始**: `.claude/agents/devil.md`(反証部隊)・`.claude/agents/audit.md`(監査部隊)を作成し、Claude Codeのサブエージェント機能として実体化した。呼び出し名(ファイル名・`name:`フィールド)は`devil`/`audit`のまま(互換性のため英語)だが、`description`や会話上での呼称は「反証部隊(Devil)」「監査部隊(Audit)」と日本語を主にしている。両エージェントとも`tools: Read, Grep, Glob, Bash`のみ(Edit/Write権限なし)に意図的に制限し、「本番ロジックを勝手に変更しない」を精神論ではなく構造的に不可能な状態として実装している。最終決定権は引き続きCEO(雄大さん)にあり、両部門は提案・指摘のみを行う。

同日中に`.claude/agents/research.md`(研究部隊)・`.claude/agents/hr.md`(人事部)・`.claude/agents/sns-research.md`(SNSリサーチ部隊)も追加した。研究部隊・人事部は反証部隊/監査部隊と同じ`tools: Read, Grep, Glob, Bash`(Edit/Write権限なし)。SNSリサーチ部隊のみ`tools: Read, Grep, Glob, WebSearch, WebFetch`(外部SNS調査のため。Bash不要、Edit/Write権限なしは同様)。人事部は「新しい部隊を作るべきか」をCEOに定量的根拠付きで進言する部門で、GARON_COMPANY_VISION.mdセクション19「将来的に部署を増やせる組織OS」を体現する。Prediction/Data/System(Operations)は既存スクリプトの萌芽のまま、Content/正式なMarketingは未着手。

**既知の制約**: 新規作成した`.claude/agents/*.md`は、作成した同一セッション内ではAgentツールのsubagent_typeとして認識されない(新しいセッションで初めて読み込まれる)。同一セッション中に使う場合はgeneral-purposeエージェントに役割定義を直接プロンプトへ埋め込んで代用する。

**2026-08-19、初回実案件**: 反証部隊(代行)にgtools実績32.7% vs シミュレーション50.0%の乖離を検証させ、`reports/devil_findings_2026-08-19_gtools_discrepancy.md`を得た。現行v7エンジンの実戦サンプルはn=10のみで50.0%はまだ実戦未検証であること、三国のVENUE_ROI定数(107.2、全場最高)がこの38日間の実測(的中率38.6%・ROI85.7%、黒字化ライン割れ)と食い違っている疑いを発見。研究部隊(代行)には`daikibo_archive_*.json`(5,973件)を分析させ、`reports/research_findings_2026-08-19.md`を得た。最有力仮説はgap15-20限定(的中率+3.2pt・ROI+26pt・最大DD大幅縮小、ただし参入数が現行の6割減)。監査部隊(代行)がkyotei_backtest.htmlのコメントから、VENUE_ROIが2026-07-28時点(n=3,146)の一度きりの計算値で3週間以上再計算されていないことを裏付けた(`reports/audit_findings_2026-08-19.md`)。人事部(代行)は新部門新設不要と結論(`reports/hr_findings_2026-08-19.md`)。SNSリサーチ部隊(代行)は5施策を提案(`reports/sns_research_findings_2026-08-19.md`)。全5部隊の統合レポートは`reports/company_report_2026-08-19.md`。

**2026-08-19、CEO承認による初の本番修正(SCORE_ENGINE_VERSION 7→8)**: `tests/recalc_venue_roi.js`(新規)でdaikibo_archive全件(n=5,044、40ファイル、2026-07-01〜08-15)を対象にVENUE_ROI/VENUE_HITRATE/OVERALL_AVG_ROI/OVERALL_AVG_HITRATEを再計算(n>=40の会場のみ採用、既存手法をそのまま踏襲)。三国は107.2→84.0(-23.2)で反証部隊・監査部隊の指摘通り大幅下方修正されたが、**それだけでなく24会場全体が想定より大きくズレていた**(戸田46.1→76.8など+30pt級の逆方向修正も複数)。CEO承認を得て24会場全てを新しい値に更新し、sg_narutou.html/kyotei_backtest.html/daikibo_replay.htmlの3ファイルに同期、回帰テストのgolden値も更新済み(スコア計算自体への影響はなし、VENUE_ROIはcalcAreScore等の対象外のため)。`scripts/lib/entry-judgment.js`はsg_narutou.htmlから実行時に定数を動的抽出するため、本番のリアルタイム判定には次回評価から自動反映される(手動同期不要)。**未解決**: `GOOD_VENUES`(◎優良会場バッジ、表示専用で参入判定には影響しない)は新しい会場別順位と食い違ったままで、CEO判断により**据え置き**(買い目に影響しないため)。

**2026-08-19、費用対効果分析とCEOによる上位方針の明確化**: `tests/hypothesis_cost_benefit.js`(新規)で新VENUE_ROI反映後の仮説再検証を実施(`reports/cost_benefit_2026-08-19.md`)。gap15-20仮説は旧VENUE_ROIの歪みに引っ張られた見かけの効果で、新VENUE_ROI下では効果がほぼ消失(ROI+26pt→+2.3pt)と判明、不採用推奨。motor2ren>=35は新旧どちらでも頑健(ROI+7〜8pt)。CEOから「1日の参入数が少なすぎるとSNS露出が下がる」との懸念があり、`tests/roi_threshold_sweep_volume.js`(新規)でROI閾値を緩めた場合の参入数を試算したところ、閾値88で希望の19.1件/日に届くがROIが89.5%(黒字化ライン割れ)に転落することが判明。**CEOより重要な方針が示された: 「参入数と精度のトレードオフは今のスコアリングの実力の限界であり、所与の制約として受け入れるべきではない。閾値を緩めても質を落とさないよう、スコアリングロジック自体(calcAreScore/buildBetsProbabilistic等)を改善するのが各部隊、特に研究部隊の本来の仕事」。** この方針を`.claude/agents/research.md`の上位目標として明記済み。

**2026-08-19、研究ログ(仮説トラッカー)を新設**: `reports/research_log.md`。試した仮説・データ期間・結果・採否を記録し、同じ静的なアーカイブを繰り返し掘り返すことによる多重比較問題(偶然のノイズを発見と誤認するリスク)を自己管理する仕組み。研究部隊・反証部隊は作業開始前に必読、作業後は追記が必須(両エージェント定義に明記済み)。新セッション開始時のチェック対象にも追加。

**2026-08-18の現状調査で判明した論点**(詳細はセッション履歴参照、今後の判断材料として要点のみ残す):
- スコア関数自体(`calcAreScore`等)はNode.js側(entry-judgment.js/weighted_optimization_search.js等)がsg_narutou.htmlから実行時抽出するため一致が構造的に保証されているが、それらを組み合わせる「グルーコード」(1号艇逆転昇格判定等)はentry-judgment.js/weighted_optimization_search.jsの2箇所に手書きで重複しており、将来ズレるリスクが残る(B: 急がないが改善余地あり)
- 「本番judgmentとバックテストロジックを事後的に突き合わせる自動チェック」が存在しない(Audit強化の具体的な次の一手候補)
- Research(`nightly_diagnosis.js`/`motor_correlation_analysis.js`)・Writer(`garon-kyotei-humanizer`スキル)は既に役割分離の萌芽があり、将来AI化する際の土台になる
- Research/SNS/Marketing AIの追加は、①上記A項目(即対応事項)が完了し、②該当業務の負担を雄大さんが繰り返し感じ始めた時、を目安に検討する

### 案件管理(CASE管理、2026-08-20〜)

GARON COMPANY構想を「5部隊が本当に案件を追跡できる組織」にするための、最小限の仕組み(Phase 1)。専用DB・Webダッシュボード・自動オーケストレーション・部隊KPIは意図的に作っていない(規模に対して過剰と判断)。

- **案件ID**: `GARON-YYYYMMDD-NNN`形式(NNNは当日3桁連番、001始まり)。5部隊(research/devil/audit/hr/sns-research)のいずれかが起点となった案件に付与する。自動採番システムは無く、[reports/cases.md](reports/cases.md)の当日既存最大値を見て手動で採番する
- **[reports/cases.md](reports/cases.md)**: 案件台帳(索引)。1案件1行で「案件ID・日付・案件名・起点部隊・現在ステータス・CEO判断・関連ファイル」のみを持つ。詳細な分析内容はここに書かず、関連ファイル(`reports/{部隊}_findings_*.md`、`reports/research_log.md`等の既存資産)を辿って確認する設計。**案件IDそのものがCompany Memoryの最小単位**であり、専用の記憶システムは別途作らない
- **ステータス値**: 検討中/反証中/監査中/CEO判断待ち/採用/却下/保留/実装中/事後監査中/完了(全て通る必要はない。起点部隊によって短い経路でもよい)
- **CEO判断の表記**: 日本語で「採用」「却下」「保留」に統一(`research_log.md`の既存表記との統一を優先)。承認事項ではない報告(例: hr部隊の「新設不要」結論、ドキュメント修正等)は無理に当てはめず「該当なし」と明記する
- **各部隊レポートの共通ヘッダー規約**: `reports/{部隊}_findings_*.md`作成時、冒頭に案件ID・起点部隊・関連ファイルを記載する(5部隊の`.claude/agents/*.md`「出力形式」節に追記済み)
- **事後Audit**: CEOが「採用」と判断し実装された案件について、承認内容と実装内容が一致しているかを`audit.md`が確認する(`.claude/agents/audit.md`に手順追加済み)。既存の回帰テスト・SCORE_ENGINE_VERSION同期確認をそのまま再利用し、新しい監査システムは作っていない
- **遡及タグ付けの方針**: 2026-08-19の既存記録のうち、起点部隊が確実に特定できたもの(8件)のみ`cases.md`へ遡及タグ付けした。特定できなかったもの(`research_log.md`のROI閾値スイープ案件等)は「案件IDなし」のまま残し、推測でのタグ付けは行っていない
- **GARON COMPANY憲法**: [GARON_COMPANY_VISION.md](GARON_COMPANY_VISION.md)第22節「重要な原則」に、既存10原則はそのまま維持した上で「組織拡大そのものを目的にしない」「新部隊は既存部隊で解決できない問題が確認された場合のみ設立検討」の2原則を追加した(独立した憲法ファイルは作らず、既存節への統合で対応)

**2026-08-20、6部隊目「異端研究部門(Heretic Research)」を新設**: `.claude/agents/heretic.md`。研究部隊が「現行GARONを改善する」のに対し、異端研究部門は「現行GARONという考え方自体が間違っているとしたら何が正しいのか」を出発点にする、明確に異なるMissionを持つ(スコアリング・軸選定・買い目構築・情報活用の前提を一切置かない)。`tools: Read, Grep, Glob, Bash, WebSearch, WebFetch`(既存5部隊のどれとも異なる組み合わせ。daikibo_archive分析にBash、外部の高ROI予想家研究にWebSearch/WebFetchが必要なため)。Edit/Write権限は他部隊と同様に無し。初回テーマは固定せず、呼び出しごとに「現行GARONの前提一覧→代替思想→検証可能性の仕分け→最有望テーマの選定」を先に行う設計。research_log.md・cases.md・案件ID運用はそのまま流用し、新しい管理システムは作っていない。ワークフローはHeretic→Devil→Audit→CEOで既存部隊と同一。**まだ研究は着手していない(組織の新設のみ完了)。**

### COO運用プロトコル(2026-08-20〜)

**「7番目のAI部隊」ではない。** `.claude/agents/coo.md`のような独立サブエージェントは作らず、**Claude Codeのメインセッション自身が、CEOから起動指示を受けた際にCOOとして振る舞うための運用プロトコル**として実装した(独立サブエージェント化を見送った理由: サブエージェントが他のサブエージェントをさらに呼び出せるか=部隊間ラリーを自律実行できるかが、このプロジェクトでは未検証・不確実なため)。

**CEOとCOOの役割分担**:
- **CEO(雄大さん)**: 承認・否認・保留、最終的な研究方針・本番ロジック変更の承認、GARON COMPANYの重要な方向性決定に集中する
- **COO(メインセッション)**: CEOが「COO、今日のGARONを進めて」のように一言指示した時点から、案件確認・研究テーマ選定・部隊選択・部隊間ラリー・反証要求・結果統合・CEO判断事項の抽出までを自律的に行う

**COOのMission**: 「GARONが年間を通じてROI100%超を実現できる可能性を最大化するため、GARON COMPANY内の研究・反証・監査・改善活動を統合し、最も期待値の高い研究経路を自律的に設計・実行すること」。部隊を動かすこと・レポートを増やすこと・組織を拡大すること自体は成果としない。

**起動時に確認すること**: `reports/cases.md`(未完了案件・CEO判断待ち案件)、`reports/research_log.md`(過去の仮説・棄却理由)、直近の`reports/company_report_*.md`、直近の各部隊`findings_*.md`。ここから「今、最も価値のある研究テーマは何か」をCOO自身が判断する。

**部隊の使い分け**(目的から逆算、機械的に全部隊を毎回動かさない):
- 現行思想を疑う→Heretic / 現行ロジックを改善→Research / 仮説を潰す→Devil(ブレーキ役。単発高配当依存・n不足・場偏り・期間偏り・前後半乖離・多重比較・データリーク・ベースライン比較を重視させる) / 実装・検証の整合性→Audit / 組織構造→HR / X・note・外部市場→SNS Research
- 1部隊だけで終わる案件があってよい。逆にHeretic→Devil→Heretic→Research→Devil→Auditのような複数ラリーも、新しい情報が増えなくなるまでは打ち切らない(無限ループは禁止)

**「次の一手」を自分で決める**: 部隊からの結果をCEOへ転送するだけで終わらせず、①何が分かったか②何が分かっていないか③単純ベースラインに勝っているか④過学習ではないか⑤ROIに繋がっているか⑥次に何を調べるべきか⑦どの部隊へ渡すか⑧ここで終了すべきか、をCOO自身が判断する。「面白い数字が出た→nが少ない→要検証」で終わらせず、必要な深掘り(前後半・場別・オッズ帯別・held-out・別条件)を自律的に行う。ただし無意味な多重比較を延々と繰り返さない。

**研究優先順位**: ROIへの直接的な影響 ＞ 買い目への影響 ＞ 参入レース選択への影響 ＞ 予測精度 ＞ その他の改善。特に「何を買うべきか/買わないべきか」「軸・順位予測を本当にする必要があるのか」「市場オッズをどう利用するか」といった買い目そのものの研究を、単純な閾値調整に収束させないよう重視する。資金配分・ベット額最適化は現時点では優先順位を下げる。

**失敗を次の研究につなげる正式モデル**: 仮説が棄却されても「不採用」で終わらせず、「なぜ失敗したか」「別の研究に使える発見はないか」を整理する。**GARON-20260820-004→005(Heretic仮説はDevilに反証され棄却されたが、反証過程で見つかったGARON本体の平和島依存問題を独立案件として分離しResearchへ引き継いだ)を、この運用の正式な先例とする。**

**案件管理**: 既存の`reports/cases.md`・`reports/research_log.md`・`reports/company_report_YYYY-MM-DD.md`をそのまま使う。新しいデータベース・ダッシュボードは作らない。

**CEO承認ゲート**: 本番ロジック変更・本番運用への反映・重要ルールの恒久変更・組織構造の重大変更は、既存のCLAUDE.mdルール通りCEO承認を必須とする。研究・分析・反証・バックテストはこの範囲内でCOOが主体的に進めてよい。

**CEOへの報告形式**: 長大な部隊レポートをそのまま転送せず、`reports/company_report_YYYY-MM-DD.md`に以下の9項目に圧縮して記録する: ■今日の最重要テーマ ■なぜこれを選んだか ■今回分かったこと ■反証結果 ■GARONのROIへの意味 ■現在の確信度 ■まだ分かっていないこと ■次にCOOが行うこと ■CEO判断が必要な事項。CEO判断が不要なら「CEO判断不要。COO継続」と明記し、必要な場合のみ「【CEO判断】採用/却下/保留」を明示する。

**現時点でできないこと**: ①CEOが何も操作しない完全無人の夜間自動起動(2026-08-19に既存記載の通り、ヘッドレスClaude Code実行時の安全性警告が未解消のため見送り中。CEOが一言メッセージを送ることが起点として必要) ②サブエージェントによる自律的な部隊間ラリー(未検証)。**将来的な完全自動化(スケジューラ→COO起動→案件確認→テーマ選定→部隊稼働→ラリー→検証→日次報告→CEO確認)へ移行する条件**: COOプロトコルが実運用で安定/部隊間ラリーが安定/案件記録漏れがない/CEO承認ゲートが確実に機能/本番環境と研究環境の分離が維持される/ヘッドレス自動実行環境の安全性が確認される、の全てを満たしてから検討する。

## ファイル構成と役割

- **sg_narutou.html** — 本番予想エンジン。BM抽出データを貼り付けてスコア計算・モード判定・買い目生成・X投稿文生成までを行う。Gemini API (`generativelanguage.googleapis.com`) を呼び出して展開コメントを生成する。
- **gtools.html** — 集計・分析ツール集。取込/分析/ログ/日報/朝投稿/的中画像などの複数タブを1ファイルに束ねたSPA。sg_narutou.htmlと同じ`localStorage`キー(`kyotei_v2`)を共有し、ベット記録・的中ログを読み書きする。
- **kyotei_backtest.html** — 夜間検証エンジン。終了レースの答え合わせ専用。本番(sg_narutou/gtools)とは完全に独立した`localStorage`キー(`kyotei_backtest_v1`)を使い、週間報告・的中率集計には一切混ざらない。プロンプトやスコア配分の検証用。
- **daikibo_archive.html** — 大規模検証アーカイブ。艇ごとの逃げ率・モーター・展示・直線・直前STなどの生データと結果をIndexedDB(`daikibo_archive_db`)にそのまま保存する専用ツール。スコア計算・モード判定・買い目生成は一切行わない(判定ロジックが変わっても過去データをそのまま再利用できるようにするための保管庫)。
- **daikibo_replay.html** — リプレイ検証。daikibo_archive.htmlでエクスポートしたJSONを読み込み、「今この瞬間の最新ロジック」(`calcAreScore`/`calcAreIndex`/`judgeMode`/`buildBetsProbabilistic`)を全件に通して、参入判定(ROI>=91・gap<10)を通過したレースだけを対象に3,000円均等回収配分でのROI・純損益を一括再計算する。**2026-08-18同期**: 長期間`SCORE_ENGINE_VERSION=5`のまま放置され、旧世代の買い目生成(`buildBetsNormal`/`buildBetsAre`、無条件全件ベット・1点100円モデル)を使い続けていたことが判明(GARON COMPANY構想レビュー時に発覚。過去の分析・判断に使われた形跡は無いことを確認済み)。sg_narutou.htmlから関数ソースを機械抽出して`SCORE_ENGINE_VERSION=7`へ更新し、実アーカイブ100件で本番判定エンジン(`entry-judgment.js`)と完全一致することを確認済み。
- **garon_gist_uploader.html** — 補助ツール。貼り付けたデータをGitHub Gistにアップロードし、Claudeとの会話にはURLだけ渡せるようにする(大きいデータをチャットに直接貼らずに済ませるため)。スコアロジックとは無関係で同期対象外。GitHubリポジトリ側では`garon gist uploader.html`(スペース区切り)という名前で置かれている。

## 重要アーキテクチャ: スコアロジックの手動複製

スコア計算・判定ロジック(`calcAreScore`, `calcAreIndex`, `judgeMode`, `buildBetsProbabilistic`, `parseData` など)は共通モジュール化されておらず、必要なファイルごとにコピー&ペーストで複製されている。買い目生成は`buildBetsProbabilistic`(確率ベース)に一本化されており、`buildBetsNigeNashi`は過去ログ互換確認用に残っているだけの未使用コード。

- `SCORE_ENGINE_VERSION`定数(2026-08-18時点で7)が **sg_narutou.html / gtools.html / kyotei_backtest.html / daikibo_replay.html** の4ファイルにそれぞれ独立して定義されている。**gtools.html内の`calcAreScore`等はどこからも呼ばれていない未使用コード**(GARON COMPANY構想レビュー時に発覚。バージョンが`5`のまま放置されていても実害は無いが、削除するかは別途判断)。
- daikibo_archive.html / daikibo_replay.html のスクリプト冒頭には「kyotei_backtest.htmlから流用（改変なし。必ず同期させること）」という明示コメントがある。
- ロジックを変更する場合は、影響する全ファイルに同じ変更を手動で反映し、`SCORE_ENGINE_VERSION`をインクリメントすること。1ファイルだけ直して終わりにしない。どのファイルが同期対象かは変更前に確認する。
- `tests/score_engine.regression.test.js`(下記参照)がsg_narutou.htmlから対象関数を毎回読み込んで実行するため、ロジック変更後は必ずこれも実行して意図した差分だけになっているか確認する。

## ストレージキー(localStorage / IndexedDB)

系統ごとにストレージが分離されている。新しいキーを追加するときは、どの系統のデータかを意識し、系統をまたいで混ざらないようにする。

| キー | 用途 | 使用ファイル |
|---|---|---|
| `kyotei_v2` | 本番のベット・結果ログ本体 | sg_narutou.html, gtools.html(共有) |
| `kyotei_gemini_key` | Gemini APIキー(クライアント側平文保存) | sg_narutou.html **のみ**(2026-08-19、監査部隊が発見: gtools.htmlの朝投稿機能`saveOhayoKey()`/`generateOhayo()`は別キー`gemini_key`を使用しており、sg_narutou.html側のキーは引き継がれない。フォールバックなし。旧記載「sg_narutou.html, gtools.html」は誤り) |
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

**インシデント記録(2026-08-17 22:10)**: `GARON_EmergencyStop`が原因不明のまま作動し、全13タスクが無効化された。原因究明の過程で`Microsoft-Windows-TaskScheduler/Operational`イベントログが既定で無効になっていたことが判明し、2026-08-18に一度有効化したが、**2026-08-19の監査部隊による調査で、実際には夜間バッチ(NightlyDiagnosis/DataQualityScan/ArchiveBackup/NightlyGitCommit/UpdateDashboard等)のLastRunTimeが2026-08-16で止まったまま、NightlyBackfill/NightlyRebootは一度も実行履歴が無い(未実行)状態が2026-08-19の対応まで続いていたことが判明した。**つまり「発見・手動復旧は2026-08-18」という当初の記載は不正確で、実質的な全面復旧は2026-08-19(全13タスクの再有効化・setup_scheduled_tasks.ps1再登録・ウォッチドッグ修正)まで及んでいた。発火元(手動クリックか他要因か)は特定できないまま。次回同種の事象が起きた際は、有効化済みの`Microsoft-Windows-TaskScheduler/Operational`ログに加え、**セッション開始時のチェック順序に「13タスクの有効化状態確認」を追加済み**(下記参照)なので早期発見できる見込み。

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
- **有効化済み(2026-08-18)**: トークン発行・`.env`設定完了、`fetch_gist_log.js`の疎通確認済み(初回759件取得)。**既知の注意点**: GitHub Gist APIは1MB超のファイルを`content`フィールドで切り詰める(`truncated:true`)。ログが増えて1MBを超えたことで一度発生し、`file.truncated`を見て`raw_url`から完全な内容を取得するフォールバックを追加して解消した。今後さらにログが増えても同じ経路で対応できる。
- **初回取得(2026-08-18)で判明した論点**: gtools実績759件の的中率(32.7%)が、シミュレーション(daikibo_archiveベース、閾値91)の的中率(50.0%)と明確に乖離。ただし単純比較はできない(実績は閾値74→82→90→91と変遷した全期間の実際の判断を含み、シミュレーションは「今の閾値91を通過したレースだけ」の集計のため、母集団が異なる)。原因調査は別途実施。

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

1. **提案レポート等** — `reports/`内の`proposal_*.md`・`data_quality_*.md`・`skip_reason_*.md`・`research_findings_*.md`・`devil_findings_*.md`・`hr_findings_*.md`・`sns_research_findings_*.md`・`audit_findings_*.md`・`company_report_*.md`(5部隊の統合レポート、2026-08-19〜)・`cost_benefit_*.md`のうち、また`reports/research_log.md`(仮説トラッカー、2026-08-19〜)に新規追記が無いかも確認する。`reports/.last_presented`(日付文字列のみのマーカーファイル。無ければ「まだ何も提示していない」扱い)の日付より新しいものが無いか確認。あれば要点を提示し、`reports/.last_presented`をその日付で更新する。(2026-08-19、人事部が発見: 5部隊の成果物ファイル名パターンが元々このチェック対象から漏れていた)
2. **13タスクの有効化状態** — `Get-ScheduledTask -TaskName "GARON_*"`で全13タスクが`Ready`になっているか確認する(2026-08-19、人事部が発見: 8/17のEmergencyStop以降、この確認がセッション開始チェックに含まれておらず約8時間の無効化に気づけなかった実例あり)。
2. **ブロック状況** — `logs/.site_block_state.json`の`blocked`/`since`/`lastCheckedAt`を確認する。
3. **ダッシュボード** — `reports/dashboard.html`の最終更新日時・累計参戦件数・的中率・ROI・純損益を確認する。
4. **現在フェーズの判定と提示** — 上記の結果を踏まえ、上記フェーズ定義のどこにいるか(基本的にはブロック状況で2↔3を判定)を一言で示し、次にすべきことを一言添える。その後で本題に入る。

### 原則: 開発作業と実際の予想発信は別物

無人稼働インフラがどのフェーズにあっても(たとえフェーズ2でブロックが続き自動化が実質止まっていても)、雄大さんの**日々のiPhoneでの予想作成・X投稿は普段通り継続する**。sg_narutou.htmlを手動で使う既存フローは本自動化インフラの外側にあり、依存関係が無い。自動化はあくまで「将来的に検証を厚くする・省力化する」ための並行トラックであり、その進捗状況を理由に日々の予想発信を止めない。

### CEOの運用体制・報告カデンス(2026-08-19〜)

- **CEO(雄大さん)は日中は本業があり、PC・Claude Codeに常時張り付いているわけではない。** 判断を仰ぐ内容は、リアルタイムで都度ではなく、まとまった形(提案書・報告書・日報)で届ける方が実態に合っている。
- **PCの運用場所(現状は暫定)**: 通常はPCを自宅に置いて電源を常時つけっぱなしにする運用が基本。ただし2026-08-16からのkyoteibiyori.comブロック(フェーズ2)が続いている間は、PCを会社に持参し、個人用iPhoneのテザリングで稼働させる暫定運用を取っている(会社用iPhoneでのテザリング実測は2026-08-19に別途実施済み、詳細は本セクション上部の運用インフラ記述参照)。ブロックが解除され次第、自宅常時稼働に戻る想定。
- **将来構想(リモート運用)**: 雄大さんが外出先からiPhoneでClaude Code本体を操作し、システムの稼働状況はntfy通知で把握する運用を目指す。あわせて、**毎朝・毎晩にClaudeから提案書・報告書・日報を提出し、CEOがそれを見て判断する**という運用フローを希望している。
- **現状とのギャップ**: 夜間(22時台)は`GARON_NightlyDiagnosis`(提案書)・`GARON_DraftSkipReason`(見送り理由下書き)・`GARON_UpdateDashboard`(ダッシュボード更新)が既に自動生成しているが、いずれも「条件を満たした時だけ」生成する設計であり、また**朝の報告に相当するものは現状存在しない**。「毎朝・毎晩」を厳密に満たすには、①朝の定時報告タスクの新設、②夜間レポート群を「条件付き生成」から「毎日必ず提出」に変える設計変更、のどちらか(または両方)が必要になる。これは今後の実装候補であり、着手前に雄大さんの確認を取ること(厳守ルール1)。
- **エンジン修正の頻度ルール(2026-08-19明言)**: スコアロジック・閾値等の本番エンジンへの修正提案は、**1日1回にまとめる**。日中に複数の改善案(例: 2026-08-19の研究部隊のgap帯仮説・反証部隊のVENUE_ROI較正ズレ指摘)が出ても、その都度バラバラに本番へ反映しない。まとめてレポート化し、CEOがそれを見て1日1回の判断で採否を決める運用とする。

## GitHubリポジトリ

`https://github.com/gt-eng-7k3xq2/kyotei` (GitHub Pagesで公開) と連携している。ローカルの`C:\garon`とは別の場所(`C:\garon\gt-eng-7k3xq2`)にcloneして運用しており、`C:\garon`自体はgit管理下ではない。

- リポジトリ側のファイル名は**スペース区切り**(例: `sg narutou.html`)。ローカルはアンダースコア区切り(`sg_narutou.html`)なので、push前に名前を対応させて手動コピーする必要がある(自動リネームの仕組みは無い)。
- `daikibo_archive_*.json`(実データ)はリポジトリに含めない(`.gitignore`で除外)。GitHub Pagesは公開サイトのため、生のレースデータを載せない方針。
- `tests/`・`CLAUDE.md`はリポジトリにも含める。

## 厳守ルール

1. **実装前に必ずユーザーに確認を取ること。** 提案・合意なしにコードの変更を書き始めない。
2. **修正後は必ず`node --check`で構文確認すること。** 上記の方法で`<script>`内容を抽出してから実行する。これらは単一HTMLファイルの実運用ツールであり、構文エラーが1つでも入るとファイル全体が読み込み不能になり、本番ツールが即座に使えなくなる。
3. **n<30のサンプルは信用しないこと。** バックテスト・検証結果でサンプル数(n)が30未満の集計は「傾向」として扱わず、結論の根拠にしない。既存コード内でもn=60〜80を「傾向として信頼できる目安」としている箇所がある(gtools.html, kyotei_backtest.html)。それより緩い閾値で判断を確定させない。
