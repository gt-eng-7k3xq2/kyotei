"""GARON-WILD(決まり手×出目ライン、カード一式)の単体テスト。仮の小さなDB(メモリ上)だけを使い、本物のDBには触れない。
実行: python tests/wild_card.test.py"""
import sys, os, json, sqlite3, unittest, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
SCR = os.path.join(HERE, '..', 'scripts', 'wild')


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCR, name + '.py'))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


B = load('build_wild_tables'); R = load('race_card')

SCHEMA = """
create table race_master(race_id text primary key, race_date text, venue_code int, race_no int, status text);
create table race_entry(race_id text, boat_no int, regno int, class_code text, national_win_rate real);
create table race_result(race_id text, boat_no int, finish_order int, actual_course int, start_timing real, winning_technique text);
create table race_payout(race_id text, bet_type text, combination text, payout_yen int);
"""


def make_db(path=':memory:'):
    c = sqlite3.connect(path); c.executescript(SCHEMA); return c


def add_race(c, rid, date, venue, order, tech, regnos=None, cls1='A2', nat1=5.8, payout=5000):
    """order: 1着・2着・3着の枠番のリスト(残りは4着以下)。tech: 1着艇の決まり手。"""
    c.execute("insert into race_master values (?,?,?,?,?)", (rid, date, venue, 1, 'resulted'))
    rest = [b for b in range(1, 7) if b not in order]; full = order + rest
    for pos, b in enumerate(full, start=1):
        c.execute("insert into race_entry values (?,?,?,?,?)", (rid, b, (regnos or {}).get(b, 1000 + b), cls1 if b == 1 else 'B1', nat1 if b == 1 else 4.0))
        c.execute("insert into race_result values (?,?,?,?,?,?)", (rid, b, pos, b, 0.15, tech if pos == 1 else None))
    c.execute("insert into race_payout values (?,?,?,?)", (rid, 'trifecta', '-'.join(map(str, order[:3])), payout))


class TestTables(unittest.TestCase):
    def setUp(self):
        self.c = make_db()
        n = 0
        for i in range(30): add_race(self.c, f'a{i}', '2025-01-10', 8, [3, 1, 4], 'まくり差し'); n += 1     # 会場8: 3号艇まくり差し → 1号艇が2着
        for i in range(10): add_race(self.c, f'b{i}', '2025-01-11', 8, [3, 4, 5], 'まくり'); n += 1
        for i in range(5): add_race(self.c, f'c{i}', '2025-01-12', 9, [4, 5, 1], 'まくり'); n += 1
        add_race(self.c, 'x', '2025-01-13', 8, [2, 1, 3], None)   # 決まり手なしは、表に入れない
        self.c.commit()

    def test_line_counts(self):
        import tempfile
        t = self._table()
        self.assertEqual(t['lines']['3|まくり差し']['1-4'], 30)
        self.assertEqual(t['lines']['3|まくり']['4-5'], 10)
        self.assertEqual(t['lines']['4|まくり']['5-1'], 5)

    def test_venue_and_global_counts(self):
        t = self._table()
        self.assertEqual(t['venue']['8|3'], {'まくり差し': 30, 'まくり': 10})
        self.assertEqual(t['venue']['9|4'], {'まくり': 5})
        self.assertEqual(t['global']['3'], {'まくり差し': 30, 'まくり': 10})

    def test_no_technique_excluded(self):
        t = self._table(); self.assertEqual(t['races'], 45)

    def _table(self):
        import tempfile
        p = os.path.join(tempfile.mkdtemp(), 't.db'); d = sqlite3.connect(p)
        self.c.backup(d); d.close(); return B.build(p)


class TestProbabilities(unittest.TestCase):
    def setUp(self):
        self.t = {'lines': {'3|まくり差し': {'1-4': 90, '1-5': 10}, '3|まくり': {'4-5': 10}, '3|差し': {}}, 'global': {'3': {'まくり差し': 100, 'まくり': 100}},
                  'venue': {'8|3': {'まくり差し': 10}}}

    def test_line_probs_enough_samples_uses_own(self):
        p, n = R.line_probs(self.t, 3, 'まくり差し')
        self.assertEqual(n, 100); self.assertAlmostEqual(p['1-4'], 0.9, places=6)

    def test_line_probs_few_samples_blends_with_all_techniques(self):
        p, n = R.line_probs(self.t, 3, 'まくり')   # 件数10 < 100: 決まり手を問わない全体(まくり差し100+まくり10)を混ぜる
        self.assertEqual(n, 10)
        self.assertAlmostEqual(sum(p.values()), 1.0, places=6)
        self.assertGreater(p['1-4'], 0.5)          # 全体の分布が混ざるので、自分の分布(4-5だけ)ではなくなる

    def test_line_probs_no_data(self):
        p, n = R.line_probs(self.t, 6, 'まくり'); self.assertEqual(p, {}); self.assertEqual(n, 0)

    def test_technique_probs_shrinks_toward_global(self):
        p, nv = R.technique_probs(self.t, 8, 3)
        self.assertEqual(nv, 10)
        # 会場の実績はまくり差し100%(10件)、全国は50%。K=50で全国へ引き寄せる: (10+50*0.5)/(10+50)=0.583
        self.assertAlmostEqual(p['まくり差し'], (10 + 50 * 0.5) / 60, places=6)
        self.assertLess(p['まくり差し'], 1.0)

    def test_technique_probs_unknown_venue_equals_global(self):
        p, nv = R.technique_probs(self.t, 99, 3); self.assertEqual(nv, 0); self.assertAlmostEqual(p['まくり差し'], 0.5, places=6)


class TestRacerStats(unittest.TestCase):
    def setUp(self):
        self.c = make_db()
        for i in range(10): add_race(self.c, f'r{i}', '2025-03-01', 8, [4, 1, 2], 'まくり', regnos={4: 4444})           # 4444は4号艇で10走10勝(まくり)
        add_race(self.c, 'r_lose', '2025-03-02', 8, [1, 2, 3], '逃げ', regnos={4: 4444})                                # 4着以下の1走
        add_race(self.c, 'future', '2026-09-30', 8, [4, 1, 2], 'まくり', regnos={4: 4444})                              # 判定日より後(先読みしない)
        self.c.commit()

    def test_stats_only_before_date(self):
        s = R.racer_stats(self.c, 4444, 4, '2026-09-26', '2025-09-26')
        self.assertEqual(s['starts'], 0)   # 2025-09-26以降で、判定日(2026-09-26)より前のデータは無い
        s2 = R.racer_stats(self.c, 4444, 4, '2026-09-26', '2025-01-01')
        self.assertEqual(s2['starts'], 11); self.assertEqual(s2['win'], round(100 * 10 / 11, 1)); self.assertEqual(s2['makuri'], round(100 * 10 / 11, 1))
        self.assertEqual(s2['top2'], round(100 * 10 / 11, 1)); self.assertAlmostEqual(s2['stAvg'], 0.15)

    def test_future_race_not_used(self):
        s = R.racer_stats(self.c, 4444, 4, '2026-09-30', '2025-01-01')   # 判定日=2026-09-30: その日のレースは含めない
        self.assertEqual(s['starts'], 11)

    def test_lane1_vulnerability(self):
        c = make_db()
        for i in range(5): add_race(c, f'v{i}', '2025-04-01', 8, [2, 1, 3], '差し', regnos={1: 1111})              # 1コースの1111が、差しで負けた
        add_race(c, 'v_w', '2025-04-02', 8, [1, 2, 3], '逃げ', regnos={1: 1111}); c.commit()
        v = R.lane1_vulnerability(c, 1111, '2026-01-01', '2025-01-01')
        self.assertEqual(v['starts'], 6); self.assertEqual(v['lost'], 5); self.assertEqual(v['byTech'], {'差し': 5})


class TestSimilarPayouts(unittest.TestCase):
    def test_distribution(self):
        c = make_db()
        for i in range(60): add_race(c, f's{i}', '2025-05-01', 8, [2, 1, 3], '差し', cls1='A2', nat1=5.8, payout=(i + 1) * 1000)   # 荒れ60件、配当は1,000〜60,000円(10〜600倍)
        for i in range(40): add_race(c, f'n{i}', '2025-05-02', 8, [1, 2, 3], '逃げ', cls1='A2', nat1=5.8, payout=1000)
        add_race(c, 'other', '2025-05-03', 8, [2, 1, 3], '差し', cls1='A1', nat1=5.8, payout=999000)   # 級別が違う(対象外)
        c.commit()
        s = R.similar_payouts(c, 8, 'A2', 5.85, '2024-01-01')
        self.assertEqual(s['races'], 100); self.assertEqual(s['upsets'], 60); self.assertEqual(s['nige'], 40)
        self.assertLess(s['p25'], s['median']); self.assertLess(s['median'], s['p75']); self.assertLess(s['p75'], s['p90'])
        self.assertEqual(s['over100'], round(100 * sum(1 for i in range(60) if (i + 1) * 10 >= 100) / 60))

    def test_no_similar_returns_none(self):
        self.assertIsNone(R.similar_payouts(make_db(), 8, 'A2', 5.8, '2024-01-01'))


def sample_req(odds=True):
    probs = [1.0 / 120] * 120
    o = {c: 20.0 + i for i, c in enumerate(R.COMBOS)} if odds else {}
    return {'raceDate': '2026-09-26', 'venueCode': 8, 'boatWin': [0.6, 0.06, 0.05, 0.1, 0.15, 0.04], 'probs': probs, 'odds': o,
            'boats': [{'lane': i + 1, 'regno': str(1000 + i + 1), 'name': f'選手{i+1}', 'cls': 'A2' if i == 0 else 'B1', 'natW': '5.8'} for i in range(6)]}


class TestStartGap(unittest.TestCase):
    def test_gap_info_inner_mean_and_sign(self):
        g = R.gap_info({1: 0.16, 2: 0.18, 3: 0.19, 4: 0.13}, 4)   # 4号艇0.13、内側(1,2,3)の平均0.177
        self.assertAlmostEqual(g['innerMean'], round((0.16 + 0.18 + 0.19) / 3, 3), places=3)
        self.assertAlmostEqual(g['gap'], round(0.13 - (0.16 + 0.18 + 0.19) / 3, 3), places=3)
        self.assertLess(g['gap'], 0)                              # 自分が速い=マイナス
        self.assertEqual([i['lane'] for i in g['inner']], [1, 2, 3])
        self.assertAlmostEqual(g['inner'][1]['vsMe'], 0.05, places=3)   # 2号艇は、自分より0.05秒遅い(凹んでいる)

    def test_gap_info_ignores_missing_inner(self):
        g = R.gap_info({1: None, 2: 0.18, 3: float('nan'), 4: 0.13}, 4)
        self.assertEqual([i['lane'] for i in g['inner']], [2]); self.assertAlmostEqual(g['gap'], -0.05, places=3)

    def test_gap_info_none_when_no_data(self):
        self.assertIsNone(R.gap_info({4: None}, 4)); self.assertIsNone(R.gap_info({1: 0.16, 4: float('nan')}, 4)); self.assertIsNone(R.gap_info({4: 0.13}, 4))

    def test_gap_history_lookup(self):
        t = {'stGap': {'4': {'basePct': 10.0, 'bins': [{'lo': -9.0, 'hi': -0.03, 'n': 1000, 'winPct': 21.0}, {'lo': -0.03, 'hi': 0.03, 'n': 5000, 'winPct': 9.0}, {'lo': 0.03, 'hi': 9.0, 'n': 800, 'winPct': 3.0}]}}}
        h = R.gap_history(t, 4, -0.05); self.assertEqual(h['winPct'], 21.0); self.assertEqual(h['lift'], 2.1)
        self.assertEqual(R.gap_history(t, 4, 0.0)['winPct'], 9.0)
        self.assertEqual(R.gap_history(t, 4, 0.03)['winPct'], 3.0)       # 境界は、上の区間へ
        self.assertIsNone(R.gap_history(t, 3, -0.05))                   # 表が無い艇番

    def test_card_uses_start_gap(self):
        t = {'lines': {}, 'global': {}, 'venue': {}, 'stGap': {'3': {'basePct': 12.0, 'bins': [{'lo': -9.0, 'hi': 9.0, 'n': 100, 'winPct': 20.0}]}}}
        c = make_db(); add_race(c, 'q', '2025-06-01', 8, [2, 1, 3], '差し', cls1='A2', nat1=5.8); c.commit()
        card = R.build_card(c, t, sample_req(), {1: 0.16, 2: 0.18, 3: 0.12, 4: 0.15, 5: 0.15, 6: 0.17})
        a3 = [a for a in card['attackers'] if a['lane'] == 3][0]
        self.assertAlmostEqual(a3['start']['gap'], round(0.12 - (0.16 + 0.18) / 2, 3), places=3)
        self.assertEqual(a3['start']['history']['winPct'], 20.0)
        card2 = R.build_card(c, t, sample_req())          # スタートを渡さなくても、カードは出る
        self.assertNotIn('start', card2['attackers'][0])


class TestCard(unittest.TestCase):
    def setUp(self):
        self.t = {'lines': {}, 'global': {}, 'venue': {}}
        for a in range(2, 7):
            for t in ['差し', 'まくり', 'まくり差し', '抜き']:
                self.t['lines'][f'{a}|{t}'] = {'1-2': 300, '1-3': 200, '2-3': 100}; self.t['global'].setdefault(str(a), {})[t] = 250
        self.c = make_db(); add_race(self.c, 'q', '2025-06-01', 8, [2, 1, 3], '差し', cls1='A2', nat1=5.8); self.c.commit()

    def test_structure_and_overview(self):
        card = R.build_card(self.c, self.t, sample_req())
        self.assertEqual(card['overview']['upset'], round(1 - 0.6, 4))
        self.assertEqual(len(card['attackers']), 5); self.assertEqual(card['attackers'][0]['lane'], 2)
        self.assertEqual(set(card['venueTechnique']), {'2', '3', '4', '5', '6'})

    def test_scenarios_sorted_and_scenario_probability(self):
        card = R.build_card(self.c, self.t, sample_req())
        pcts = [s['scenarioPct'] for s in card['scenarios']]
        self.assertEqual(pcts, sorted(pcts, reverse=True))
        s5 = [s for s in card['scenarios'] if s['winner'] == 5 and s['tech'] == 'まくり'][0]
        self.assertAlmostEqual(s5['scenarioPct'], round(100 * 0.15 * 0.25, 2), places=2)   # エンジンの1着確率×決まり手の確率(各25%)
        ln = s5['lines'][0]; self.assertEqual(ln['combo'], '5-1-2')                          # 出目ラインの最頻(1-2: 300/600)
        self.assertAlmostEqual(ln['linePct'], 50.0, places=1); self.assertAlmostEqual(ln['jointPct'], round(s5['scenarioPct'] * 0.5, 2), places=2)

    def test_ev_uses_engine_probability(self):
        card = R.build_card(self.c, self.t, sample_req())
        ln = card['scenarios'][0]['lines'][0]
        self.assertAlmostEqual(ln['ev'], round((1.0 / 120) * ln['odds'], 2), places=2)   # エンジンの確率(1/120)×オッズ

    def test_without_odds_still_works(self):
        card = R.build_card(self.c, self.t, sample_req(odds=False))
        self.assertIsNone(card['scenarios'][0]['lines'][0]['odds']); self.assertEqual(card['aiPick']['lines'], [])

    def test_ai_pick_rule(self):
        card = R.build_card(self.c, self.t, sample_req())
        ai = card['aiPick']; self.assertLessEqual(len(ai['lines']), 13)   # おまかせ案(画面側autoPlan)と同じ: 最大13点
        self.assertTrue(all(l['odds'] >= 10.0 for l in ai['lines']))
        self.assertTrue(all(not l['combo'].startswith('1-') for l in ai['lines']))   # 1号艇が頭の出目は入れない
        heads = [l['combo'][0] for l in ai['lines']]; self.assertTrue(all(heads.count(h) <= 8 for h in set(heads)))   # 1つの頭は最大8点
        ps = [l['enginePct'] for l in ai['lines']]; self.assertEqual(ps, sorted(ps, reverse=True))     # エンジン確率の高い順(確率×オッズでは選ばない)
        self.assertIn('参考', ai['note'])
        if ai['lines']: self.assertAlmostEqual(ai['goseiOdds'], round(1.0 / sum(1.0 / l['odds'] for l in ai['lines']), 2), places=2)

    def test_odds_floor(self):
        req = sample_req(); req['odds'] = {c: 9.0 for c in R.COMBOS}   # 全てオッズ9倍(10倍未満)
        self.assertEqual(R.build_card(self.c, self.t, req)['aiPick']['lines'], [])

    def test_read_only_db(self):
        # 読み取り専用で開いたDBに、書き込みが起きないこと
        import tempfile
        p = os.path.join(tempfile.mkdtemp(), 'ro.db'); d = sqlite3.connect(p); self.c.backup(d); d.close()
        ro = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        R.build_card(ro, self.t, sample_req())
        with self.assertRaises(sqlite3.OperationalError): ro.execute("insert into race_master values ('z','2026-01-01',1,1,'x')")


class EntryInfo(unittest.TestCase):
    """参入の目安(条件A・強め)の判定。境界の値を確かめる。"""
    def req(self, nat1, others):
        boats = [{'lane': 1, 'natW': str(nat1)}] + [{'lane': i + 2, 'natW': str(v)} for i, v in enumerate(others)]
        return {'engineInput': {'boats': boats}}

    def test_condition_a_boundaries(self):
        ok = R.entry_info({1: 0.15, 2: 0.16, 3: 0.17, 4: 0.18}, {'ln_w720_lane1': 0.335}, self.req(5.41, [5.77, 4, 4, 4, 4]))
        self.assertTrue(ok['condA'])                                   # ちょうど境界(以下)は含む
        self.assertFalse(R.entry_info(None, {'ln_w720_lane1': 0.336}, self.req(5.41, [6, 4, 4, 4, 4]))['condA'])   # 逃げ率が少し高い
        self.assertFalse(R.entry_info(None, {'ln_w720_lane1': 0.3}, self.req(5.42, [6, 4, 4, 4, 4]))['condA'])     # 勝率が少し高い
        self.assertFalse(R.entry_info(None, {'ln_w720_lane1': 0.3}, self.req(5.0, [5.76, 4, 4, 4, 4]))['condA'])   # 他の最高勝率が基準ちょうど(超えていない)

    def test_strong_needs_st_gap(self):
        # 2026-10-05: 目安=荒れスコア>=0.7。強=目安 かつ 旧条件A かつ 攻め艇のSTが0.04秒以上速い
        base = {'ln_w720_lane1': 0.3}; rq = self.req(5.0, [6.5, 4, 4, 4, 4]); U = 0.75
        self.assertEqual(R.entry_info({1: 0.20, 2: 0.16, 3: 0.19, 4: 0.19}, base, rq, U)['tier'], 'strong')    # 攻め艇が0.04秒速い
        self.assertEqual(R.entry_info({1: 0.20, 2: 0.17, 3: 0.19, 4: 0.19}, base, rq, U)['tier'], 'a')         # 0.03秒差は強めに届かない
        self.assertEqual(R.entry_info(None, base, rq, U)['tier'], 'a')                                        # STが取れないときは候補まで
        # 旧条件Aを満たさなくても、荒れスコアが高ければ候補(新基準)
        self.assertEqual(R.entry_info({1: 0.2, 2: 0.16, 3: 0.19, 4: 0.19}, {'ln_w720_lane1': 0.5}, rq, U)['tier'], 'a')

    def test_new_tier_is_upset_threshold(self):
        base = {'ln_w720_lane1': 0.3}; rq = self.req(5.0, [6.5, 4, 4, 4, 4])
        self.assertEqual(R.entry_info(None, base, rq, 0.7)['tier'], 'a')            # ちょうど0.7は含む
        self.assertEqual(R.entry_info(None, base, rq, 0.6999)['tier'], 'none')      # 0.7に届かない
        self.assertEqual(R.entry_info({1: 0.20, 2: 0.16, 3: 0.19, 4: 0.19}, base, rq, 0.69)['tier'], 'none')  # 旧条件の強でも、荒れスコアが低ければ対象外
        self.assertEqual(R.entry_info(None, base, rq, None)['tier'], 'none')        # 荒れスコアが無ければ判定しない
        self.assertEqual(R.entry_info(None, {}, rq, 0.9)['tier'], 'a')              # 逃げ率が取れなくても、荒れスコアだけで判定できる

    def test_missing_data_is_none(self):
        self.assertEqual(R.entry_info(None, {}, self.req(5.0, [6, 4, 4, 4, 4]))['tier'], 'none')             # 荒れスコアが渡されなければ判定しない


if __name__ == '__main__':
    unittest.main(verbosity=1)
