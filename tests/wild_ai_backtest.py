"""GARON-WILD のAIおすすめの、組み立て方を比べる(2026-09-26)。
完全に未来の期間(学習に使っていない 2025-12-21〜2026-09-18、42,296レース)で、エンジンの予測確率(eval_P)と実際の着順・払戻を使う。
どの方法も、1点あたり同額を買った場合の的中率と回収率。オッズは過去データに無いので、「オッズ10倍以上」は、予測確率から作った目安(0.75/確率)で代用する。
使い方: python tests/wild_ai_backtest.py  (engine_db/data が必要。読み取りだけ)"""
import numpy as np, itertools, sys, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'engine_db', 'data')
z = np.load(os.path.join(ROOT, 'dataset.npz'), allow_pickle=True)
date = z['date']; te = date >= '2025-12-21'
fin = z['fin'][te]; payy = z['payy'][te]; payc = z['payc'][te]
P = np.load(os.path.join(ROOT, 'eval_P_2025-12-21.npy')).astype(np.float64)
R = len(P)
COMBOS = [(a, b, c) for a, b, c in itertools.permutations(range(6), 3)]
names = np.array([f'{a+1}-{b+1}-{c+1}' for a, b, c in COMBOS])
order = np.argsort(fin, axis=1)             # order[:,0]=1着の艇(0始まり)
truth = np.array([f'{order[i,0]+1}-{order[i,1]+1}-{order[i,2]+1}' for i in range(R)])
assert np.mean(truth == payc) > 0.999
head = np.array([c[0] for c in COMBOS])
win = np.stack([P[:, head == k].sum(1) for k in range(6)], 1)   # 各艇の1着確率
top3 = np.stack([P[:, [i for i, c in enumerate(COMBOS) if k in c]].sum(1) for k in range(6)], 1)
hitidx = np.array([np.where(names == t)[0][0] for t in truth])

def evaluate(select, mask, label):
    """select(r) -> 買う組み合わせ番号の配列。maskのレースだけ。"""
    n = 0; hit = 0; stake = 0; ret = 0.0; pts = 0
    for r in np.where(mask)[0]:
        s = select(r)
        if len(s) == 0: continue
        n += 1; pts += len(s); stake += len(s)
        if hitidx[r] in set(s): hit += 1; ret += payy[r] / 100.0   # 払戻は100円あたりの円
    print(f'{label:52s} レース{n:6d} 平均{pts/max(n,1):5.1f}点 的中{100*hit/max(n,1):5.1f}% 回収{100*ret/max(stake,1):5.1f}%', flush=True)
    return hit / max(n, 1)

def top_overall(K):
    def f(r): return np.argsort(-P[r])[:K]
    return f

def heads_plan(nheads, per_head, odds_min=None, exclude_first=True, first_extra=1):
    """頭が別々の艇を nheads 個。頭は、1号艇以外で1着確率が高い順。各頭ごとに、確率の高い出目を per_head 点(先頭の頭だけ +first_extra)。"""
    def f(r):
        hs = [k for k in np.argsort(-win[r]) if not (exclude_first and k == 0)][:nheads]
        out = []
        for i, h in enumerate(hs):
            idx = np.where(head == h)[0]
            idx = idx[np.argsort(-P[r, idx])]
            if odds_min: idx = [j for j in idx if 0.75 / P[r, j] >= odds_min]
            out += list(idx[:per_head + (first_extra if i == 0 else 0)])
        return np.array(out, dtype=int)
    return f

def heads_budget(K, nheads, odds_min=None, exclude_first=True):
    """点数の合計Kを、頭が別々の nheads 個に、頭の1着確率に比例して配る。各頭の中は確率の高い順。"""
    def f(r):
        hs = [k for k in np.argsort(-win[r]) if not (exclude_first and k == 0)][:nheads]
        w = np.array([win[r, h] for h in hs]); alloc = np.maximum(1, np.round(K * w / w.sum())).astype(int)
        out = []
        for h, a in zip(hs, alloc):
            idx = np.where(head == h)[0]; idx = idx[np.argsort(-P[r, idx])]
            if odds_min: idx = [j for j in idx if 0.75 / P[r, j] >= odds_min]
            out += list(idx[:a])
        return np.array(out[:K + 2], dtype=int)
    return f

def pool_top(K, exclude_first=True, odds_min=None):
    """頭を決めず、1号艇が頭でない出目の中から、確率の高い順にK点。"""
    def f(r):
        idx = np.where(head != 0)[0] if exclude_first else np.arange(120)
        idx = idx[np.argsort(-P[r, idx])]
        if odds_min: idx = [j for j in idx if 0.75 / P[r, j] >= odds_min]
        return np.array(idx[:K], dtype=int)
    return f

if __name__ == '__main__':
    for name, mask in [('荒れ想定(1号艇の1着確率<0.45)', win[:, 0] < 0.45), ('強く荒れ想定(<0.35)', win[:, 0] < 0.35)]:
        print('\n■', name, 'レース数', int(mask.sum()))
        print('  荒れの実際: 1号艇が1着でなかった割合 %.1f%%' % (100 * np.mean(order[mask, 0] != 0)))
        evaluate(top_overall(13), mask, '基準: 全体の上位13点')
        evaluate(pool_top(13), mask, '1号艇頭なし・上位13点')
        evaluate(pool_top(13, odds_min=10), mask, '1号艇頭なし・上位13点・10倍以上(目安)')
        evaluate(heads_plan(3, 4, None), mask, '現行: 頭3つ(5/4/4点)・オッズ条件なし')
        evaluate(heads_plan(3, 4, 10), mask, '現行: 頭3つ(5/4/4点)・10倍以上(目安)')
        evaluate(heads_budget(13, 3), mask, '頭3つ・13点を頭の確率で配分')
        evaluate(heads_budget(13, 2), mask, '頭2つ・13点を頭の確率で配分')
        evaluate(heads_budget(13, 4), mask, '頭4つ・13点を頭の確率で配分')


def capped(K, cap, min_heads=1, odds_min=None):
    """確率の高い順にK点。ただし、1つの頭には最大cap点まで。1号艇は頭にしない。"""
    def f(r):
        idx = np.where(head != 0)[0]; idx = idx[np.argsort(-P[r, idx])]
        if odds_min: idx = [j for j in idx if 0.75 / P[r, j] >= odds_min]
        out = []; cnt = {}
        for j in idx:
            h = head[j]
            if cnt.get(h, 0) < cap: out.append(j); cnt[h] = cnt.get(h, 0) + 1
            if len(out) >= K: break
        return np.array(out, dtype=int)
    return f

def study():
    for name, mask in [('荒れ想定(1号艇の1着確率<0.45)', win[:, 0] < 0.45)]:
        print('\n■ 頭の上限を変えた比較(13点) ', name)
        for cap in (13, 8, 7, 6, 5, 4):
            f = capped(13, cap)
            evaluate(f, mask, f'確率順13点・1つの頭は最大{cap}点')
        # 頭の数(実際に何艇が頭になるか)
        for cap in (13, 7, 6, 5):
            f = capped(13, cap); hc = [len(set(head[f(r)])) for r in np.where(mask)[0][:3000]]
            print(f'   cap{cap}: 頭の数の平均 {np.mean(hc):.2f}  2艇以上の割合 {100*np.mean(np.array(hc)>=2):.0f}%  3艇以上 {100*np.mean(np.array(hc)>=3):.0f}%')
        for K in (8, 10, 13, 16):
            f = capped(K, 6); evaluate(f, mask, f'確率順{K}点・1つの頭は最大6点')
if __name__ == '__main__':
    study()
