# M2並行比較のJS実装と、Python(研究用の評価基盤 research/eval_harness_20261103/rules.py)の計算が一致するかの参照値を出す。標準出力にJSON。
import sys, os, json, glob, numpy as np
sys.stdout.reconfigure(encoding='utf-8')
H = 'C:/garon/research/eval_harness_20261103/'; sys.path.insert(0, H); import rules as R
th = json.load(open('C:/garon/scripts/m2_params_v1.json', encoding='utf-8')); a, b = th['a'], th['b']
date = sys.argv[1]; lim = int(sys.argv[2]); out = []
for fp in sorted(glob.glob('C:/garon/logs/wild/cards/%s/*.json' % date))[:lim]:
    j = json.load(open(fp, encoding='utf-8')); c = j.get('card'); cb = c['combos']
    if len(cb) != 120 or any((cb[k]['odds'] is None or cb[k]['odds'] <= 0) for k in R.COMBOS): continue
    p = np.array([cb[k]['enginePct'] / 100 for k in R.COMBOS]); p = p / p.sum(); o = np.array([cb[k]['odds'] for k in R.COMBOS], float)
    q = (1 / o) / (1 / o).sum(); S = a * np.log(p + 1e-12) + b * np.log(q); E = np.exp(S - S.max()); pm = E / E.sum()
    f0 = R.race_features(p, o); f2 = R.race_features(pm, o)
    out.append(dict(file=os.path.basename(fp), l0=[R.COMBOS[i] for i in f0['lines12']] if f0['lines12'] is not None else None, r0=f0['rank'], p12_0=f0.get('p12'), l2=[R.COMBOS[i] for i in f2['lines12']] if f2['lines12'] is not None else None, r2=f2['rank'], p12_2=f2.get('p12'), pm_head=[float(x) for x in pm[:5]], m0=bool(f0['M']), x0=bool(f0['X']), m2=bool(f2['M']), x2=bool(f2['X'])))
print(json.dumps(out))
