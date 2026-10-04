const fs=require('fs'),p='logs/wild/';
const res={};for(const f of fs.readdirSync(p)){const m=f.match(/^results(?:_manual)?_(\d{4}-\d{2}-\d{2})\.json$/);if(!m)continue;const j=JSON.parse(fs.readFileSync(p+f,'utf8'));for(const[k,v]of Object.entries(j))if(v&&v.chakuju&&v.payout)res[m[1]+'|'+k]=v;}
const R=[];
for(const d of fs.readdirSync(p+'cards')){for(const f of fs.readdirSync(p+'cards/'+d)){let c;try{c=JSON.parse(fs.readFileSync(p+'cards/'+d+'/'+f,'utf8'))}catch(e){continue}
 const card=c.card||c;const m=f.match(/^(.+?)_(\d+)R/);if(!m)continue;const r=res[d+'|'+m[1]+'_'+m[2]];if(!r||!card.combos)continue;
 const pay=Number(String(r.payout).replace(/[¥,]/g,''));if(!isFinite(pay))continue;
 const t3=[0,0,0,0,0,0],win=[0,0,0,0,0,0];for(const[k,v]of Object.entries(card.combos)){const p=(v.enginePct||0)/100,b=k.split('-').map(Number);b.forEach(x=>t3[x-1]+=p);win[b[0]-1]+=p}
 R.push({v:m[1],n:Number(m[2]),pay,ch:r.chakuju.split('-').map(Number),t3,win,man:pay>=10000});}}
const M=R.filter(x=>x.man);console.log('万舟',M.length,'/',R.length);
const cnt=(a,f)=>{const o={};a.forEach(x=>{const k=f(x);o[k]=(o[k]||0)+1});return o};
console.log('万舟の頭',JSON.stringify(cnt(M,x=>x.ch[0])),' 全体の頭',JSON.stringify(cnt(R,x=>x.ch[0])));
console.log('万舟での1号艇の着順',JSON.stringify(cnt(M,x=>{const i=x.ch.indexOf(1);return i<0?'着外':(i+1)+'着'})),' 非万舟',JSON.stringify(cnt(R.filter(x=>!x.man),x=>{const i=x.ch.indexOf(1);return i<0?'着外':(i+1)+'着'})));
// 1号艇の3着内確率(エンジン)で区分
const s=R.map(x=>x.t3[0]).sort((a,b)=>a-b);const q=[s[Math.floor(s.length/3)],s[Math.floor(2*s.length/3)]];
console.log('1号艇の3着内確率の3分位境界',q.map(v=>v.toFixed(2)));
[['低(1号艇が飛びそう)',x=>x.t3[0]<q[0]],['中',x=>x.t3[0]>=q[0]&&x.t3[0]<q[1]],['高',x=>x.t3[0]>=q[1]]].forEach(([l,f])=>{const a=R.filter(f);const m=a.filter(x=>x.man).length;const out=a.filter(x=>!x.ch.includes(1)).length;console.log(l.padEnd(18),'n='+a.length,'1号艇が着外'+out+'('+(100*out/a.length).toFixed(0)+'%)','万舟'+m+'('+(100*m/a.length).toFixed(0)+'%)','配当中央値',a.map(x=>x.pay).sort((x,y)=>x-y)[Math.floor(a.length/2)]);});
// 万舟の会場・R番号
console.log('万舟の会場',JSON.stringify(cnt(M,x=>x.v)));
console.log('万舟のR番号帯',JSON.stringify(cnt(M,x=>x.n<=4?'1-4R':x.n<=8?'5-8R':'9-12R')),' 全体',JSON.stringify(cnt(R,x=>x.n<=4?'1-4R':x.n<=8?'5-8R':'9-12R')));
// 万舟の出目の特徴: 外枠(4-6)が頭か
console.log('万舟の頭が4〜6号艇',M.filter(x=>x.ch[0]>=4).length,'/',M.length,' 全体',R.filter(x=>x.ch[0]>=4).length,'/',R.length);

// ---- ロマン枠の試作(均等100円/点) ----
const full=[];
for(const d of fs.readdirSync(p+'cards')){for(const f of fs.readdirSync(p+'cards/'+d)){let c;try{c=JSON.parse(fs.readFileSync(p+'cards/'+d+'/'+f,'utf8'))}catch(e){continue}
 const card=c.card||c;const m=f.match(/^(.+?)_(\d+)R/);if(!m)continue;const r=res[d+'|'+m[1]+'_'+m[2]];if(!r||!card.combos)continue;const pay=Number(String(r.payout).replace(/[¥,]/g,''));if(!isFinite(pay))continue;
 const t3=[0,0,0,0,0,0];for(const[k,v]of Object.entries(card.combos)){const pp=(v.enginePct||0)/100;k.split('-').forEach(x=>t3[Number(x)-1]+=pp)}
 full.push({card,r,pay,t3});}}
function test(name,entry,pick,K){let pts=0,ret=0,hits=0,n=0;for(const x of full){if(!entry(x))continue;const L=Object.entries(x.card.combos).filter(([c,v])=>v.odds&&pick(c,v)).sort((a,b)=>(b[1].enginePct||0)-(a[1].enginePct||0)).slice(0,K);if(!L.length)continue;n++;pts+=L.length;if(L.some(([c])=>c===x.r.chakuju)){hits++;ret+=x.pay}}
 console.log(name.padEnd(46),'レース'+n,'点'+pts,'的中'+hits,'('+(100*hits/Math.max(1,n)).toFixed(1)+'%)','回収率'+(100*ret/Math.max(1,pts*100)).toFixed(0)+'%');}
console.log('\n--- ロマン枠 試作(40倍以上のみ、100円/点)');
const low=x=>x.t3[0]<q[0], all=()=>true;
for(const K of [5,10]){
 test('全レース/40倍超/1頭なし 上位'+K,all,(c,v)=>!c.startsWith('1-')&&v.odds>=40,K);
 test('1号艇飛びそう/40倍超/1頭なし 上位'+K,low,(c,v)=>!c.startsWith('1-')&&v.odds>=40,K);
 test('1号艇飛びそう/40倍超/1号艇を完全に除く 上位'+K,low,(c,v)=>!c.includes('1')&&v.odds>=40,K);
 test('1号艇飛びそう/40倍超/頭は4〜6号艇 上位'+K,low,(c,v)=>Number(c[0])>=4&&v.odds>=40,K);
 test('1号艇飛びそう/100倍超/1頭なし 上位'+K,low,(c,v)=>!c.startsWith('1-')&&v.odds>=100,K);}
