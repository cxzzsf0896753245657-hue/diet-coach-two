// 減重教練 主程式（由 index.html 的開機程式在讀完 IndexedDB 後載入）
// 結構：資料層 → 共用小工具（toast／底部視窗／確認視窗） → Health Connect → AI → 各分頁畫面 → 背景執行／自動總結 → 啟動
const $=s=>document.querySelector(s),K='dietcoach_v1';
const newId=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const byT=(a,b)=>String(a.t).localeCompare(String(b.t));

// ======================= 資料層 =======================
var lastSer={},needMigrate=false,fullNext=false,saveT=null,saving=false,again=false,useLS=false,noSave=false,lastPruneDay='';
function bootDb(){
  const B=window.__BOOT||{};let d=null;
  try{
    if(B.meta){d=JSON.parse(B.meta);d.days={};lastSer={meta:B.meta};const rv=[];
      for(const k of Object.keys(B.chunks||{}).sort()){const v=B.chunks[k];lastSer[k]=v;if(k[0]==='d')Object.assign(d.days,JSON.parse(v));else if(k[0]==='r')rv.push(...JSON.parse(v))}
      d.rvh=rv}
    else if(B.legacy){d=JSON.parse(B.legacy);needMigrate=true}
  }catch(e){console.error('讀取資料失敗',e);noSave=true;window.__loadErr=String(e)}
  useLS=!window.MAINDB;return d||{days:{},p:{}};
}
let db=bootDb();
// 補齊欄位、舊格式升級。回傳 true 代表有改動需要存檔。
function upgradeDb(){
  let ch=false;
  db.p??={};db.days??={};db.foods??=[];db.routines??=[];db.tags??=[];
  if(!db.rvh){db.rvh=Object.entries(db.rv||{}).map(([kind,v])=>({kind,...v}));ch=true}
  // 舊版另外存「各類最新一份」(rv)；現在只留完整紀錄 rvh，最新一份從 rvh 算
  if(db.rv){for(const[kind,v]of Object.entries(db.rv))if(v&&v.date&&!db.rvh.some(r=>r.kind===kind&&r.date===v.date))db.rvh.push({kind,date:v.date,text:v.text});delete db.rv;ch=true}
  db.rvh.forEach(r=>{if(!r.pk){r.pk=r.kind+':'+r.date;ch=true}});
  for(const d of Object.values(db.days)){
    if(!Array.isArray(d.meals)){d.meals=[];ch=true}
    for(const m of d.meals)if(!m.id){m.id=newId('m');ch=true}   // 每筆餐點都有自己的 id，不再用陣列位置辨認
  }
  return ch;
}
const upgraded=upgradeDb();
const chunkOf=k=>'d:'+k.slice(0,7);
function save(){bgSoon();if(noSave)return;clearTimeout(saveT);saveT=setTimeout(()=>flush(),250)}
async function flush(all){
  clearTimeout(saveT);if(noSave)return;
  if(useLS){try{localStorage.setItem(K,JSON.stringify(db))}catch(e){toast('儲存失敗：空間已滿')}return}
  if(saving){again=true;if(all)fullNext=true;return}
  saving=true;
  try{do{again=false;const a=all||fullNext;fullNext=false;all=false;await persist(a)}while(again)}
  catch(e){toast(e&&e.name==='QuotaExceededError'?'儲存失敗：手機儲存空間不足':'儲存失敗：'+((e&&e.message)||e))}
  finally{saving=false}
}
async function persist(all){
  const meta={...db};delete meta.days;delete meta.rvh;const dch={},rch={};
  for(const[k,v]of Object.entries(db.days))(dch[chunkOf(k)]??={})[k]=v;
  db.rvh.forEach(r=>(rch['r:'+String(r.date).slice(0,4)]??=[]).push(r));
  const keep=new Set(['meta']),puts=[],ms=JSON.stringify(meta);if(all||lastSer.meta!==ms)puts.push(['meta',ms]);
  for(const[c,v]of Object.entries(dch)){keep.add(c);const s=JSON.stringify(v);if(all||lastSer[c]!==s)puts.push([c,s])}
  for(const[c,v]of Object.entries(rch)){keep.add(c);const s=JSON.stringify(v);if(all||lastSer[c]!==s)puts.push([c,s])}
  const existing=all?await MAINDB.keys():Object.keys(lastSer),dels=existing.filter(k=>!keep.has(k));
  await MAINDB.write(puts,dels);puts.forEach(([k,s])=>lastSer[k]=s);dels.forEach(k=>delete lastSer[k]);
}
// AI 總結：kind 的最新一份（before 有給就找該日期之前的）
function latestRv(kind,before){let b=null;db.rvh.forEach(r=>{if(r.kind===kind&&(!before||r.date<before)&&(!b||r.date>=b.date))b=r});return b}
const rvFind=(kind,date)=>db.rvh.find(r=>r.pk===kind+':'+date);
const realDay=d=>!!d&&((d.meals&&d.meals.length>0)||d.weight!=null||d.steps!=null||d.kcalOut!=null||!!d.ex||!!d.h);
function pruneOld(){
  // 只保留最近 5 年。多重防護：以「有真實資料的最新日期」與今天取較早者為基準（手機日期錯亂時不會誤刪）；
  // 最近 60 天要有至少 14 天的真實紀錄才動作；每次最多刪 62 天。
  const ks=Object.keys(db.days).sort(),real=ks.filter(k=>realDay(db.days[k]));if(real.length<2)return 0;
  const last=real[real.length-1],ref=last<today()?last:today(),lo=ymd(new Date(new Date(ref+'T00:00').getTime()-60*864e5));
  if(real.filter(k=>k<=ref&&k>lo).length<14)return 0;
  const d0=new Date(ref+'T00:00');d0.setFullYear(d0.getFullYear()-5);const cut=ymd(d0);
  let n=0;for(const k of ks){if(k>=cut||n>=62)break;(db.days[k].meals||[]).forEach(m=>{if(m.imgId)delImg(m.imgId)});delete db.days[k];n++}
  if(n){const ld=ks[n-1];db.rvh=db.rvh.filter(r=>String(r.date)>ld);save()}return n;
}
function normalizeDb(){
  let ch=false;const have=new Set(db.rvh.filter(r=>r.kind==='day').map(r=>r.date));
  Object.entries(db.days).forEach(([k,d])=>{if(d.review!==undefined){if(!have.has(k)){db.rvh.push({kind:'day',date:k,text:d.review,pk:'day:'+k});have.add(k)}delete d.review;ch=true}});
  const n=pruneOld();lastPruneDay=today();if(n)toast(`已刪除 5 年前的舊資料（${n} 天）`);
  if(ch||n){save();render()}return n;
}
async function finishMigrate(){
  if(!needMigrate||useLS||noSave)return;needMigrate=false;
  try{
    await flush(true);const a=await MAINDB.all();let days=0,rv=0,meta=false;
    a.keys.forEach((k,i)=>{if(k==='meta')meta=true;else if(k[0]==='d')days+=Object.keys(JSON.parse(a.vals[i])).length;else if(k[0]==='r')rv+=JSON.parse(a.vals[i]).length});
    if(meta&&days===Object.keys(db.days).length&&rv===db.rvh.length){localStorage.removeItem(K);toast('資料已升級到新的儲存方式')}
    else toast('資料升級驗證失敗，已保留舊資料');
  }catch(e){toast('資料升級失敗，已保留舊資料')}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){flush();toastCommit()}else{if(lastPruneDay!==today())normalizeDb();applyRoutines()}});
addEventListener('pagehide',()=>{flush()});
const ymd=d=>new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,10);
const today=()=>ymd(new Date()),day=k=>db.days[k]??={meals:[]};
const kin=d=>(d.meals||[]).reduce((a,m)=>a+(m.ai?.kcal||0),0);
function addD(k,n){const d=new Date(k+'T00:00');d.setDate(d.getDate()+n);return ymd(d)}
const has=d=>d&&(d.meals.length||d.weight||d.steps);

// ======================= 共用小工具 =======================
const RM=matchMedia('(prefers-reduced-motion: reduce)');
// toast：可帶一個動作按鈕（例如「復原」）。act.done 是「沒按復原、時間到」時要做的收尾（例如真的刪掉照片）。
function toastCommit(){const f=toast.fin;toast.fin=null;if(f)f()}
function toast(t,act){
  const e=$('#toast'),a=$('#toasta');clearTimeout(toast.t);toastCommit();
  $('#toastt').textContent=t;
  if(act){a.hidden=false;a.textContent=act.label;toast.fin=act.done||null;a.onclick=()=>{toast.fin=null;clearTimeout(toast.t);e.classList.remove('show');act.fn()}}
  else{a.hidden=true;a.onclick=null}
  e.classList.add('show');toast.t=setTimeout(()=>{e.classList.remove('show');toastCommit()},act?5000:3500);
}
// 底部視窗：開、關（有往下滑出的動畫）、使用者主動關閉（返回鍵、下拉、點背景）
function openSheet(d){if(d._cl){clearTimeout(d._cl);d._cl=0;d.classList.remove('closing');d.style.transform=''}if(!d.open)d.showModal();document.activeElement?.blur?.()}
function closeSheet(d){if(!d.open||d._cl)return;if(RM.matches){d.close();return}d.classList.remove('drag');d.classList.add('closing');d._cl=setTimeout(()=>{d._cl=0;d.classList.remove('closing');d.style.transform='';d.close()},200)}
function dismissSheet(d){closeSheet(d);const f=d._onDismiss;if(f)f()}
const topSheet=()=>[...document.querySelectorAll('dialog[open]')].filter(d=>!d._cl).pop();
document.querySelectorAll('dialog').forEach(d=>{
  d.addEventListener('cancel',e=>{e.preventDefault();dismissSheet(d)});
  // 從上方把手／標題區往下拉就關閉
  let y0=null,dy=0;
  d.addEventListener('touchstart',e=>{const t=e.touches[0],r=d.getBoundingClientRect();if(d.scrollTop>0||t.clientY-r.top>70||e.target.closest('input,textarea,select')){y0=null;return}y0=t.clientY;dy=0},{passive:true});
  d.addEventListener('touchmove',e=>{if(y0==null)return;dy=Math.max(0,e.touches[0].clientY-y0);if(dy>4){d.classList.add('drag');d.style.transform=`translateY(${dy}px)`}},{passive:true});
  d.addEventListener('touchend',()=>{if(y0==null)return;y0=null;if(dy>90){dismissSheet(d);return}d.classList.remove('drag');if(dy>4){d.style.transition='transform .2s';d.style.transform='';setTimeout(()=>d.style.transition='',220)}});
});
// 沒有輸入欄位的視窗，點背景也可以關閉
['#asd','#dlg','#cfm','#gdlg'].forEach(s=>{const d=$(s);d.addEventListener('click',e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientY<r.top||e.clientY>r.bottom||e.clientX<r.left||e.clientX>r.right)dismissSheet(d)})});
$('#dlgx').onclick=()=>closeSheet($('#dlg'));
// App 內的確認視窗（取代系統 confirm）
function ask(title,msg='',ok='確定',danger=false){
  return new Promise(res=>{
    const d=$('#cfm'),y=$('#cfmy');$('#cfmt').textContent=title;$('#cfmm').textContent=msg;$('#cfmm').hidden=!msg;
    y.textContent=ok;y.style.background=danger?'#c43d3d':'';let done=false;
    const fin=v=>{if(done)return;done=true;d._onDismiss=null;closeSheet(d);res(v)};
    y.onclick=()=>fin(true);$('#cfmn').onclick=()=>fin(false);d._onDismiss=()=>fin(false);openSheet(d);
  });
}
// 數字動畫：元素先以「上一次的值」畫出來，再過渡到新值
const animLast={};
const aw=(k,pct)=>{pct=Math.max(0,Math.min(100,+pct||0)).toFixed(1);return`data-ak="${k}" data-aw="${pct}" style="width:${animLast[k]??0}%"`};
function animate(root){
  const els=root.querySelectorAll('[data-ak]');if(!els.length)return;void root.offsetWidth;
  els.forEach(e=>{const k=e.dataset.ak;if(e.dataset.aw!=null){e.style.width=e.dataset.aw+'%';animLast[k]=e.dataset.aw}else{e.style.strokeDasharray=e.dataset.ad;animLast[k]=e.dataset.ad}});
}
var errT=0;window.__onRuntimeError=m=>{if(Date.now()-errT<5000)return;errT=Date.now();toast('發生錯誤：'+m)};

// ======================= Health Connect 同步 =======================
async function sync(days=30,quiet=false){
  if(sync.busy)return;sync.busy=true;$('#sync').classList.add('spin');
  try{await syncInner(days,quiet)}finally{sync.busy=false;$('#sync').classList.remove('spin')}
}
async function syncInner(days,quiet){
  const H=window.Capacitor?.Plugins?.Health;
  if(!H)return toast('請在 Android App 內使用同步');
  const ok=[],fails=[];
  try{
    const a=await H.isAvailable();
    if(!a.available){if(quiet)return;await H.openHealthConnectSettings();return toast('請先安裝或更新 Health Connect')}
    let types=[...RD];const unsup=[];
    for(let i=0;i<RD.length;i++){
      try{await H.requestAuthorization({read:types,write:[],requestHistoryAccess:true});break}
      catch(e){const m=/Unsupported data type:\s*(\w+)/i.exec(e.message);if(!m||!types.includes(m[1]))throw e;types=types.filter(t=>t!==m[1]);unsup.push(m[1])}
    }
    const end=new Date(),start=new Date(end-days*864e5);start.setHours(0,0,0,0);
    const q={startDate:start.toISOString(),endDate:end.toISOString()},dk=s=>ymd(new Date(s.startDate)),num=s=>+(s.value??s.values?.sum??s.values?.average??0);
    const agg=async(t,g)=>(await H.queryAggregated({dataType:t,...q,bucket:'day',aggregation:g})).samples;
    const rs=async(t,limit=2000)=>(await H.readSamples({dataType:t,...q,limit,ascending:true})).samples;
    const err=e=>/permission|authori|denied/i.test(e.message)?'未授權':e.message,hh=k=>day(k).h??={};
    const put=(sp,k,v)=>{if(sp.pct&&v<=1)v*=100;if(sp.f)v=sp.f(v);if(!isFinite(v))return 0;const d=day(k);if(sp.top)d[sp.top]=sp.top==='weight'?+v.toFixed(1):Math.round(v);else hh(k)[sp.k]=+v.toFixed(1);return 1};
    for(const sp of SPEC){
      if(unsup.includes(sp.t))continue;
      try{
        const m=new Map();
        if(sp.how==='last'){for(const s of await rs(sp.t,1000))m.set(dk(s),num(s))}
        else{
          let done=false;
          try{for(const s of await agg(sp.t,sp.how==='sum'?'sum':'average'))m.set(dk(s),num(s));done=true}catch(_){}
          if(!done){const g={};for(const s of await rs(sp.t,5000))(g[dk(s)]??=[]).push(num(s));
            for(const[k,v]of Object.entries(g))m.set(k,v.reduce((x,y)=>x+y,0)/(sp.how==='sum'?1:v.length))}
        }
        let n=0;for(const[k,v]of m)n+=put(sp,k,v);if(n)ok.push(`${sp.n} ${n} 天`);
      }catch(e){fails.push(`${sp.n}：${err(e)}`)}
    }
    // 消耗熱量：1) 總消耗（彙總）  2) 總消耗（逐筆，依來源）  3) 活動熱量＋基礎（沒有基礎資料時用估算）
    let kdone=false;const rest0=restKcal(),partial=(v,k)=>rest0&&k!==today()&&v<0.75*rest0;
    try{const sm=await agg('totalCalories','sum');if(sm.length){sm.forEach(s=>{const k=dk(s),v=Math.round(num(s)),d=day(k);d.kcalSrc={'Health Connect 彙總':v};delete d.kcalBas;if(partial(v,k))d.kcalAct=v;else delete d.kcalAct});kdone=true;ok.push(`消耗熱量（彙總）${sm.length} 天`)}}catch(_){}
    if(!kdone){try{
      const by={};(await rs('totalCalories',5000)).forEach(s=>{const k=dk(s),src=String(s.sourceName||s.sourceId||s.source||'未知來源');(by[k]??={})[src]=(by[k][src]||0)+num(s)});
      const ks=Object.keys(by);ks.forEach(k=>{const d=day(k),m=Object.fromEntries(Object.entries(by[k]).map(([a,v])=>[a,Math.round(v)])),mx=Math.max(...Object.values(m));d.kcalSrc=m;delete d.kcalBas;if(partial(mx,k))d.kcalAct=mx;else delete d.kcalAct});
      if(ks.length){kdone=true;ok.push(`消耗熱量（逐筆）${ks.length} 天`)}
    }catch(e){fails.push('總消耗熱量：'+err(e))}}
    if(!kdone){try{
      const act=await agg('calories','sum'),bas={};let hasBas=false;try{(await agg('basalCalories','sum')).forEach(s=>{bas[dk(s)]=Math.round(num(s));hasBas=true})}catch(__){}
      act.forEach(s=>{const k=dk(s),a=Math.round(num(s)),b=bas[k],d=day(k);d.kcalSrc={'活動熱量':a};if(b!=null){d.kcalSrc['活動＋基礎']=a+b;d.kcalBas=true;delete d.kcalAct}else{d.kcalAct=a;delete d.kcalBas}});
      if(act.length){kdone=true;ok.push(`消耗熱量（${hasBas?'活動＋基礎':'只有活動熱量，基礎代謝用估算'}）${act.length} 天`)}
    }catch(e){fails.push('消耗熱量：'+err(e))}}
    {const seen=recalcKcal();db.kSrcSeen=seen;const nm=Object.keys(seen);if(nm.length)ok.push(`消耗來源：${nm.join('、')}`)}
    // 睡眠（每天睡了幾小時，算在醒來那天）
    if(!unsup.includes('sleep'))try{const g={};for(const s of await rs('sleep',3000)){const st=String(s.sleepState??'').toLowerCase();if(/awake|out/.test(st)||!s.endDate)continue;
        const k=ymd(new Date(s.endDate));g[k]=(g[k]||0)+(new Date(s.endDate)-new Date(s.startDate))/36e5}
      let n=0;for(const[k,v]of Object.entries(g))if(v>0){hh(k).sleep=+v.toFixed(1);n++}if(n)ok.push(`睡眠 ${n} 天`)}catch(e){fails.push('睡眠：'+err(e))}
    // 血壓（當天最後一筆）
    if(!unsup.includes('bloodPressure'))try{let n=0;for(const s of await rs('bloodPressure',500)){const sy=s.systolic??s.value?.systolic,di=s.diastolic??s.value?.diastolic;if(sy&&di){hh(dk(s)).bp=`${Math.round(sy)}/${Math.round(di)}`;n++}}if(n)ok.push(`血壓 ${n} 筆`)}catch(e){fails.push('血壓：'+err(e))}
    // 運動紀錄
    if(!unsup.includes('workouts'))try{if(H.queryWorkouts){const r=await H.queryWorkouts({...q,limit:300,ascending:true}),L=r.workouts||r.samples||[],byDay={};
        L.forEach(w=>{const min=Math.round((new Date(w.endDate)-new Date(w.startDate))/6e4);if(!(min>0))return;(byDay[dk(w)]??=[]).push({n:String(w.workoutType??w.type??'運動'),min,kcal:Math.round(w.totalEnergyBurned??w.calories??0)})});
        Object.entries(byDay).forEach(([k,v])=>hh(k).wk=v);if(L.length)ok.push(`運動紀錄 ${L.length} 筆`)}}catch(e){fails.push('運動紀錄：'+err(e))}
    db.syncLog={at:new Date().toLocaleString(),ok,fails,skip:unsup};db.lastSync=Date.now();save();render();
    if(!quiet||fails.length)toast(fails.length?`同步完成，${fails.length} 項失敗（見設定 → Health Connect）`:`已同步最近 ${days} 天`);
  }catch(e){toast('同步失敗：'+e.message)}
}

// ======================= AI =======================
function aiErr(status,j){
  const m=j?.error?.message||'';
  if(status===429)return'使用次數超過限制（免費額度可能用完），請稍後再試';
  if(status===401||status===403||/API key not valid|API_KEY_INVALID|invalid x-api-key/i.test(m))return'金鑰無效或沒有權限，請到「設定 → AI 連線」檢查';
  if(status===404||/not found|is not supported/i.test(m))return'找不到這個模型名稱，請到「設定 → AI 連線」檢查';
  if(status>=500)return'AI 服務暫時忙碌，請稍後再試';
  return m||('AI 回傳錯誤（'+status+'）');
}
async function aiFetch(url,opt,ms=90000){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);
  try{const r=await fetch(url,{...opt,signal:c.signal});const j=await r.json().catch(()=>({}));if(!r.ok||j.error){const e=Error(aiErr(r.status,j));e.status=r.status;throw e}return j}
  catch(e){if(e.name==='AbortError')throw Error('AI 回應逾時，請檢查網路後再試');if(e instanceof TypeError)throw Error('連不上 AI 服務，請檢查網路');throw e}
  finally{clearTimeout(t)}
}
const GEMINI_DEF='gemini-3.8-flash',GEMINI_FB='gemini-3.1-flash-lite';
// json=true：要求 AI 只回 JSON（Gemini 用官方的 JSON 模式）
async function ai(content,system,max=1500,json=false){
  const p=db.p,blocks=typeof content==='string'?[{type:'text',text:content}]:content;
  if((p.prov||'gemini')==='gemini'){
    if(!p.gkey)throw Error('請先在設定填入 Gemini API Key');
    const body=JSON.stringify({systemInstruction:{parts:[{text:system}]},
        contents:[{role:'user',parts:blocks.map(b=>b.type==='image'?{inlineData:{mimeType:b.source.media_type,data:b.source.data}}:{text:b.text})}],
        generationConfig:{maxOutputTokens:Math.max(max*4,2048),...(json?{responseMimeType:'application/json'}:{})}});
    const call=model=>aiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':p.gkey},body});
    let j;
    // 沒自訂模型時用 GEMINI_DEF；萬一這個名稱哪天被下架（404），自動退回 GEMINI_FB
    if(p.gmodel)j=await call(p.gmodel);
    else try{j=await call(GEMINI_DEF)}catch(e){if(e.status!==404&&e.status!==400)throw e;j=await call(GEMINI_FB)}
    const t=(j.candidates?.[0]?.content?.parts||[]).filter(x=>!x.thought).map(x=>x.text||'').join('');
    if(!t)throw Error('AI 沒有回覆內容，請再試一次');return t;
  }
  if(!p.key)throw Error('請先在設定填入 Claude API Key');
  const j=await aiFetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'content-type':'application/json','x-api-key':p.key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-sonnet-5-5',max_tokens:max,system,messages:[{role:'user',content}]})});
  const t=(j.content||[]).map(c=>c.text||'').join('');if(!t)throw Error('AI 沒有回覆內容，請再試一次');return t;
}
function parseJson(t){
  const s=String(t||'').replace(/```(?:json)?/gi,''),a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a<0||b<a)throw Error('AI 回傳的格式不正確，請再試一次');
  try{return JSON.parse(s.slice(a,b+1))}catch(e){throw Error('AI 回傳的格式不正確，請再試一次')}
}
const numOrNull=v=>v==null||v===''||!isFinite(+v)?null:+v;
function cleanNut(o){
  const r={kcal:numOrNull(o.kcal),protein_g:numOrNull(o.protein_g),carb_g:numOrNull(o.carb_g),fat_g:numOrNull(o.fat_g),fiber_g:numOrNull(o.fiber_g)};
  if(r.kcal==null||r.kcal<0)throw Error('AI 沒有估出熱量，請補充說明後再試');
  Object.keys(r).forEach(k=>{if(r[k]!=null)r[k]=Math.max(0,Math.round(r[k]))});
  return r;
}

// ======================= 照片 =======================
const isHeic=f=>/heic|heif/i.test(f.type)||/\.(heic|heif)$/i.test(f.name||'');
var _heicLoad=null;
function loadHeic2any(){
  if(window.heic2any)return Promise.resolve();
  if(_heicLoad)return _heicLoad;
  return _heicLoad=new Promise((ok,no)=>{
    const s=document.createElement('script');s.src='vendor/heic2any.min.js';  // 已內建在 App 裡，不用網路
    s.onload=()=>ok();s.onerror=()=>{_heicLoad=null;no(Error('HEIC 轉換元件載入失敗'))};
    document.head.appendChild(s);
  });
}
const decodeImg=u=>new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>no(Error('無法讀取這張照片，可能是不支援的格式'));i.src=u});
async function shrink(f,max=640,qual=.6){
  let blob=f,u='';
  if(isHeic(f)){
    try{await loadHeic2any();let out=await heic2any({blob:f,toType:'image/jpeg',quality:.7});if(Array.isArray(out))out=out[0];blob=out}
    catch(e){throw Error('這張 HEIC 照片無法轉換，換一張試試或改用 JPG/PNG')}
  }
  u=URL.createObjectURL(blob);
  try{const i=await decodeImg(u);const m=max/Math.max(i.width,i.height,max),c=document.createElement('canvas');c.width=Math.max(1,i.width*m);c.height=Math.max(1,i.height*m);c.getContext('2d').drawImage(i,0,0,c.width,c.height);return c.toDataURL('image/jpeg',qual)}
  finally{URL.revokeObjectURL(u)}
}
const idb=new Promise((ok,no)=>{const r=indexedDB.open('dc_img',1);r.onupgradeneeded=()=>r.result.createObjectStore('i');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
const tx=async(mode,fn)=>{const d=await idb;return new Promise((ok,no)=>{const q=fn(d.transaction('i',mode).objectStore('i'));q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)})};
const putImg=(k,v)=>tx('readwrite',s=>s.put(v,k)),getImg=k=>tx('readonly',s=>s.get(k)),delImg=k=>tx('readwrite',s=>s.delete(k));
function loadImgs(){document.querySelectorAll('img[data-img]').forEach(async e=>{const id=e.dataset.img;if(id&&!e.getAttribute('src')){const v=await getImg(id).catch(()=>null);if(v)e.src=v;else{e.alt='照片載入失敗';e.style.visibility='visible'}}})}
(async()=>{let ch=0;for(const d of Object.values(db.days))for(const m of d.meals)if(m.img){m.imgId=newId('i');await putImg(m.imgId,m.img);delete m.img;ch=1}if(ch){save();render()}})();

// ======================= AI 總結 =======================
function dline(k){const d=db.days[k]||{};return `${k}｜體重${d.weight??'-'}kg｜步數${d.steps??'-'}｜消耗${d.kcalOut??'-'}kcal｜攝取${kin(d)||'-'}kcal${nutDig(d)}｜${d.ex?`運動強度：${EXL[d.ex]}｜`:''}${d.tags&&d.tags.length?`標記：${d.tags.map(tagN).join('、')}｜`:''}${hxText(d)}${(d.meals||[]).map(m=>m.ai&&`${isSnack(m)?'點心:':''}${m.ai.name}`).filter(Boolean).join('、')||'無紀錄'}`}
const FMT='\n請依下列格式回答，繁體中文，直接開始、不要寒暄或自我介紹，不要重複列出原始數據：\n## 重點\n用 2～3 句話總結。\n## 做得好\n- 最多 3 點\n## 要注意\n- 最多 3 點，每點附一個具體數字\n## 下一步\n- 最多 3 個馬上能做的行動\n全文不超過 300 字；粗體只用在關鍵數字或關鍵詞，每段最多一處。';
const INSTR={day:'請給今日總結，內容涵蓋：今天做得好的、熱量與蛋白質、碳水、脂肪、纖維和目標的差距、運動強度是否合適、明天最重要的 1～2 個具體行動（可建議食物）。'+FMT,
    week:'請給本週檢討，內容涵蓋：體重與熱量趨勢、營養素是否達標、飲食規律問題、運動量，並列出下週要調整的 3 件事；若進度落後目標日期，誠實說明並調整預期。'+FMT,
    month:'請給本月檢討，內容涵蓋：整體進度是否符合目標日期、哪些習慣有效或無效、營養素是否長期偏離目標、是否需要調整每日熱量或運動目標，以及下個月的 3 個重點。'+FMT},
  SYS='你是溫和但誠實的減重教練。直接進入內容，不要寒暄或自我介紹。用繁體中文、簡潔、具體可執行。熱量估算有誤差，請提醒趨勢比單日數字重要。不做醫療診斷；不建議極端節食，每日攝取不應低於使用者的基礎代謝；若有身體不適或慢性病，建議諮詢醫師。';
const KN={day:'今日總結',week:'本週檢討',month:'本月檢討'},KNN={day:1,week:7,month:30};
function summaryHead(){const p=db.p,w=curWeight();return`使用者資料：目前${w??'-'}kg，目標${p.wt||'-'}kg，目標日期${p.dt||'未設定'}，身高${p.ht||'-'}cm。${tgLine()}`}
// 提示詞用的是 runners/background.js 裡的同一份 DCJobs.buildPrompt（App 與背景共用）
function buildReviewPrompt(kind,end){
  if(!window.DCJobs)throw Error('缺少共用程式 runners/background.js，請重新打包');
  const days={};for(let i=0;i<KNN[kind];i++){const k=addD(end,-i);days[k]=dline(k)}
  return DCJobs.buildPrompt({head:summaryHead(),days,prev:{[kind]:latestRv(kind,end)?.text},instr:INSTR},kind,end);
}
async function review(kind,end=today(),auto=false){
  if(!auto)toast('AI 分析中…');
  try{const text=await ai(buildReviewPrompt(kind,end),SYS);const pk=kind+':'+end;db.rvh=db.rvh.filter(r=>r.pk!==pk);db.rvh.push({kind,date:end,text,pk,...(auto?{auto:true}:{})});save();render();toast(auto?`已自動產生${KN[kind]}（${end}）`:`已產生${KN[kind]}`);return true}
  catch(e){if(!auto||!/請先在設定填入/.test(e.message))toast((auto?'自動產生失敗：':'')+e.message);return false}
}
document.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>review(b.dataset.r));
async function regenDay(k){
  if(rvFind('day',k)&&!await ask('要覆蓋這天的總結嗎？','會用目前的紀錄重新產生一份，舊的會被取代。','重新產生'))return;
  if(await review('day',k)){hs.sel=k;renderHist()}
}

// ======================= 設定頁：每一欄改了就自動儲存 =======================
const rmIds=['rd','rdt','rw','rwd','rwt','rm','rmd','rmt','aut','bgr'];
const PF=['w0','wt','dt','ht','sx','by','bm','bd','act','rate','tk','tp','tc','tf','tb'];
const readRm=()=>Object.fromEntries(rmIds.map(i=>[i,$('#'+i).type==='checkbox'?$('#'+i).checked:$('#'+i).value]));
var bdBad=0;const readBd=()=>{const y=$('#by').value,m=$('#bm').value,d=$('#bd').value;if(!y||!m||!d)return db.p.bd||'';const dt=new Date(+y,+m-1,+d);if(dt.getMonth()!==+m-1){bdBad=1;return db.p.bd||''}return`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`};
function saveProfile(){
  const p=db.p,v=id=>$('#'+id).value,nn=id=>v(id)===''?null:+v(id);
  bdBad=0;
  Object.assign(p,{w0:nn('w0'),wt:nn('wt'),dt:v('dt'),ht:nn('ht'),sx:v('sx'),bd:readBd(),act:v('act'),rate:v('rate'),tk:+v('tk')||0,tp:+v('tp')||0,tc:+v('tc')||0,tf:+v('tf')||0,tb:+v('tb')||0,rm:readRm()});
  if(bdBad)toast('這個生日日期不存在，沿用原本的生日');
  save();render();
}
var pfT=null;
$('#t-set').addEventListener('change',e=>{const id=e.target.id;if(PF.includes(id))saveProfile();else if(rmIds.includes(id)){saveProfile();remindSoon()}});
$('#t-set').addEventListener('input',e=>{if(['w0','wt','ht','tk','tp','tc','tf','tb'].includes(e.target.id)){clearTimeout(pfT);pfT=setTimeout(saveProfile,700)}});
// 畫面重畫時，不覆蓋使用者正在輸入的那一欄
function setV(id,v){const e=$('#'+id);if(e&&document.activeElement!==e)e.value=v}
function renderSet(){
  const p=db.p;
  ['w0','wt','dt','ht','gkey','gmodel'].forEach(k=>setV(k,p[k]??''));setV('key',p.key??'');$('#prov').value=p.prov||'gemini';
  ['tk','tp','tc','tf','tb'].forEach(k=>setV(k,p[k]||''));{const[b1,b2,b3]=(p.bd||'--').split('-');setV('by',b1||'');setV('bm',b2?+b2:'');setV('bd',b3?+b3:'')}
  setV('sx',p.sx||'f');setV('act',p.act||'1.375');setV('rate',p.rate||'0.5');
  if(p.rm)rmIds.forEach(i=>{const e=$('#'+i);if(document.activeElement===e)return;e.type==='checkbox'?e.checked=(p.rm[i]===undefined?true:p.rm[i]):e.value=p.rm[i]??e.value});
  const n=Object.keys(db.days).length;$('#bkl').textContent=(db.lastBackup?`上次備份：${db.lastBackup}`:'還沒備份過')+(n>14&&(!db.lastBackup||Date.now()-new Date(db.lastBackup)>30*864e5)?'｜建議現在備份':'');
  const sl=db.syncLog;$('#ss').textContent=sl?`上次同步 ${sl.at}｜成功 ${sl.ok.length} 項${sl.fails.length?`｜失敗 ${sl.fails.length} 項`:''}`:'尚未同步';
  $('#sl').innerHTML=sl?esc(sl.ok.join('、'))+(sl.fails.length?'<br>失敗：'+esc(sl.fails.join('；')):'')+(sl.skip?.length?'<br>此外掛不支援（已略過）：'+esc(sl.skip.join('、')):''):'';
  aiUi();ksrcUi();bgStatus();renderTsug();renderAct();renderTagMgr();
}

// ======================= 歷史分頁 =======================
let hs={tab:'cal',ym:today().slice(0,7),sel:null,ry:+today().slice(0,4),rf:'week',rn:20},tr=30;
const esc=t=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null,f1=v=>v==null?'-':v.toFixed(1),r0=v=>v?Math.round(v):'-';
const chg=v=>v==null?'-':(v>0?'+':'')+v.toFixed(1)+'kg';
const monthKeys=ym=>{const[y,m]=ym.split('-').map(Number),n=new Date(y,m,0).getDate();return[...Array(n)].map((_,i)=>`${ym}-${String(i+1).padStart(2,'0')}`)};
function stat(keys){
  const ds=keys.map(k=>db.days[k]).filter(Boolean),ws=ds.map(d=>d.weight).filter(Boolean);
  return{n:ds.filter(has).length,w:avg(ws),dw:ws.length>1?ws.at(-1)-ws[0]:null,kin:avg(ds.map(kin).filter(Boolean)),st:avg(ds.map(d=>d.steps).filter(Boolean))};
}
const LG=(bg,round)=>`<span class="lg" style="background:${bg};margin-left:0${round?';border-radius:50%;width:7px;height:7px':''}"></span>`;
function viewCal(){
  const ks=monthKeys(hs.ym),[y,m]=hs.ym.split('-').map(Number),first=new Date(y,m-1,1).getDay(),t=today(),s=stat(ks);
  if(!hs.sel||!hs.sel.startsWith(hs.ym))hs.sel=ks.includes(t)?t:ks.filter(k=>k<=t&&has(db.days[k])).at(-1)||null;
  let h=`<div class="row nav"><button class="alt" data-nav="-1" aria-label="上個月">‹</button><b>${y} 年 ${m} 月</b><button class="alt" data-nav="1" aria-label="下個月" ${hs.ym>=t.slice(0,7)?'disabled':''}>›</button></div>`;
  h+=`<p class="mut">記錄 ${s.n} 天｜吃點心 ${ks.filter(k=>hasSnack(db.days[k])).length} 天｜平均體重 ${f1(s.w)}kg｜月內變化 ${chg(s.dw)}｜平均攝取 ${r0(s.kin)} kcal｜平均步數 ${r0(s.st)}</p>`;
  h+='<div class="cal">'+[...'日一二三四五六'].map(c=>`<span class="mut">${c}</span>`).join('')+'<i></i>'.repeat(first);
  ks.forEach((k,i)=>{const d=db.days[k],c=[];if(d&&kin(d)&&d.kcalOut)c.push(kin(d)<=d.kcalOut?'g':'a');if(k===hs.sel)c.push('sel');
    h+=`<button class="${c.join(' ')}" data-day="${k}" ${k>t?'disabled':''} aria-label="${k}${hasSnack(d)?'，有吃點心零食':''}">${i+1}${(d&&(d.meals.length||hasSnack(d)))||tagDots(d)?`<span class="dts">${d&&d.meals.length?'<i class="dm"></i>':''}${hasSnack(d)?'<i class="ds"></i>':''}${tagDots(d)}</span>`:''}</button>`});
  const usedT=[...new Set(ks.flatMap(k=>(db.days[k]?.tags||[])))].filter(t=>(db.tags||[]).some(x=>x.id===t));
  return h+`</div><p class="mut">${LG('color-mix(in srgb,var(--ok) 45%,var(--card))')}吃得比消耗少　${LG('color-mix(in srgb,var(--warn) 55%,var(--card))')}吃得比消耗多　${LG('var(--ink)',1)}有餐點　${LG('var(--warn)',1)}點心</p>`
  +(usedT.length?`<p class="mut">${usedT.map(t=>LG(tagC(t),1)+esc(tagN(t))).join('　')}</p>`:'')
  +(hs.sel?dayCard(hs.sel):'<p class="mut">這個月還沒有紀錄</p>');
}
function viewYr(){
  const ms=[...Array(12)].map((_,i)=>`${hs.ry}-${String(i+1).padStart(2,'0')}`).map(ym=>({ym,s:stat(monthKeys(ym))})).filter(r=>r.s.n),ys=stat(ms.flatMap(r=>monthKeys(r.ym)));
  return`<div class="row nav"><button class="alt" data-ynav="-1" aria-label="前一年">‹</button><b>${hs.ry} 年</b><button class="alt" data-ynav="1" aria-label="後一年" ${hs.ry>=+today().slice(0,4)?'disabled':''}>›</button></div><p class="mut">全年記錄 ${ys.n} 天｜平均體重 ${f1(ys.w)}kg｜全年變化 ${chg(ys.dw)}</p>`
   +(ms.map(r=>`<button class="li" style="grid-template-columns:40px 1fr" data-ym="${r.ym}"><b>${+r.ym.slice(5)} 月</b><span>${f1(r.s.w)}kg｜月內 ${chg(r.s.dw)}<br><span class="mut">攝取均 ${r0(r.s.kin)} kcal｜記錄 ${r.s.n} 天</span></span></button>`).join('')||'<p class="mut">這一年沒有紀錄</p>');
}
function viewRv(){
  const all=db.rvh.filter(r=>hs.rf==='all'||r.kind===hs.rf).slice().sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0),sh=all.slice(0,hs.rn);
  return`<div class="seg" style="margin-bottom:8px">${[['week','週'],['month','月'],['day','日'],['all','全部']].map(([k,l])=>`<button data-rf="${k}" class="${hs.rf===k?'on':''}">${l}</button>`).join('')}</div>`
   +(sh.map(r=>`<button class="li" style="grid-template-columns:86px 1fr" data-rv="${esc(r.pk)}"><b>${r.date}</b><span>${KN[r.kind]||''}${r.auto?'・自動':''}<br><span class="mut">${esc(plain(r.text).slice(0,26))}…</span></span></button>`).join('')||'<p class="mut">還沒有這類檢討紀錄</p>')
   +(all.length>sh.length?`<button class="alt" data-more="1">顯示更多（還有 ${all.length-sh.length} 筆）</button>`:'');
}
function renderHist(){
  document.querySelectorAll('#seg button').forEach(b=>b.classList.toggle('on',b.dataset.t===hs.tab));
  const el=$('#hist'),q=(s,f)=>el.querySelectorAll(s).forEach(f);
  el.innerHTML=hs.tab==='cal'?viewCal():hs.tab==='yr'?viewYr():viewRv();
  q('[data-nav]',b=>b.onclick=()=>{const[y,m]=hs.ym.split('-').map(Number);hs.ym=ymd(new Date(y,m-1+ +b.dataset.nav,1)).slice(0,7);renderHist()});
  q('[data-day]',b=>b.onclick=()=>{hs.sel=b.dataset.day;renderHist()});
  q('[data-ynav]',b=>b.onclick=()=>{hs.ry+=+b.dataset.ynav;renderHist()});
  q('[data-ym]',b=>b.onclick=()=>{hs.tab='cal';hs.ym=b.dataset.ym;hs.sel=null;renderHist()});
  q('[data-rf]',b=>b.onclick=()=>{hs.rf=b.dataset.rf;hs.rn=20;renderHist()});
  q('[data-more]',b=>b.onclick=()=>{hs.rn+=20;renderHist()});
  q('[data-rv]',b=>b.onclick=()=>{const r=db.rvh.find(x=>x.pk===b.dataset.rv);if(!r)return;$('#dtt').textContent=`${r.date}｜${KN[r.kind]}`;$('#dtx').innerHTML=mdHtml(r.text);openSheet($('#dlg'))});
  loadImgs();
}
$('#seg').onclick=e=>{const t=e.target.dataset.t;if(t){hs.tab=t;renderHist()}};
$('#trs').onclick=e=>{const n=e.target.dataset.n;if(n){tr=n==='all'?'all':+n;drawCharts()}};
const trN=()=>tr==='all'?Math.max(30,Math.ceil((Date.now()-new Date(Object.keys(db.days).filter(k=>db.days[k].weight).sort()[0]||today()))/864e5)+1):tr;
function jumpTo(k){hs.tab='cal';hs.ym=k.slice(0,7);hs.sel=k;renderHist();showTab('hist')}

// ======================= 備份與還原 =======================
async function exportBk(){
  const r=$('#bkr').value,cut=r==='all'?'':ymd(new Date(Date.now()-90*864e5));toast('打包中…');
  const imgs={};
  if(r!=='none')for(const[k,d]of Object.entries(db.days))if(!cut||k>=cut)for(const m of d.meals)if(m.imgId){const v=await getImg(m.imgId).catch(()=>null);if(v)imgs[m.imgId]=v}
  const p={...db.p};if(!$('#bkkey').checked){delete p.key;delete p.gkey}const out=JSON.stringify({v:1,at:new Date().toISOString(),db:{...db,p},imgs});
  const name=`diet-coach-backup-${today()}.json`,F=window.Capacitor?.Plugins?.Filesystem,S=window.Capacitor?.Plugins?.Share;
  try{
    if(F&&S){
      const o={path:name,directory:'CACHE',encoding:'utf8'};let uri;
      for(let i=0;i<out.length;){let e=Math.min(i+2e6,out.length);const c=out.charCodeAt(e-1);if(c>=0xD800&&c<=0xDBFF&&e<out.length)e--;
        const data=out.slice(i,e);if(i===0)uri=(await F.writeFile({...o,data})).uri;else await F.appendFile({...o,data});i=e}
      await S.share({title:name,url:uri,dialogTitle:'儲存備份檔'});
    }else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out],{type:'application/json'}));a.download=name;a.click()}
    db.lastBackup=today();save();render();toast('備份完成');
  }catch(e){toast('備份失敗：'+e.message)}
}
$('#bk').onclick=exportBk;
$('#bki').onchange=async e=>{
  const f=e.target.files[0];e.target.value='';if(!f)return;
  try{
    const j=JSON.parse(await f.text());if(j.v!==1||!j.db?.days)throw Error('不是有效的備份檔');
    if(!await ask('還原備份？',`會取代目前所有資料（備份日期 ${j.at?.slice(0,10)||'不明'}）。`,'還原',true))return;
    for(const[id,v]of Object.entries(j.imgs||{}))await putImg(id,v);
    const old=db.p;db=j.db;db.p={...(db.p||{}),key:db.p?.key||old.key,gkey:db.p?.gkey||old.gkey,rm:db.p?.rm||old.rm};upgradeDb();fullNext=true;normalizeDb();keysSave();save();render();toast('已還原');
  }catch(err){toast('還原失敗：'+err.message)}
};

// ======================= 食物庫 =======================
const busy=new Set();var fe=null,md={img:null,items:[]};
const foodMatch=q=>db.foods.filter(f=>!q||f.name.toLowerCase().includes(q.toLowerCase())).sort((a,b)=>(b.used||0)-(a.used||0)||(a.so??-1)-(b.so??-1)||a.name.localeCompare(b.name,'zh-Hant'));  // 常用的在前；沒用過的：自己建的 → 常見食物（依常用程度） → 名稱
const CATS=[['staple','主食'],['protein','蛋白質'],['veg','蔬菜'],['fruit','水果'],['dairy','乳製品'],['drink','飲料'],['snack','點心'],['other','其他']];
const CATCOL=['#b8862b','#c1562f','#3f7a50','#c4453f','#4f78a8','#2a8a8a','#a8508e','#7d7068'];
// 分類圖示（線條風格，和 App 其他圖示一致）
const CATI={staple:'<path d="M4 12h16a8 8 0 0 1-16 0z"/><path d="M7.5 12c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/>',
  protein:'<path d="M12 3c3.6 0 6 5.2 6 9.2A6 6 0 0 1 6 12.2C6 8.2 8.4 3 12 3z"/>',
  veg:'<path d="M5 19C5 11 10 5 19 5c0 9-6 14-14 14z"/><path d="M5 19l8-8"/>',
  fruit:'<path d="M12 7.5c-2-1.4-7-1.4-7 3.8C5 15.4 7.4 20 10 20c1 0 1.4-.5 2-.5s1 .5 2 .5c2.6 0 5-4.6 5-8.7 0-5.2-5-5.2-7-3.8z"/><path d="M12 7.5C12 5.5 13 4 15 3"/>',
  dairy:'<path d="M8.5 3h7v3l2.5 3.5V21H6V9.5L8.5 6z"/><path d="M6 10h12"/>',
  drink:'<path d="M6 7h12l-1.6 13H7.6z"/><path d="M12.5 7l2-4h3"/>',
  snack:'<circle cx="12" cy="12" r="8"/><circle cx="9.5" cy="9.5" r=".9"/><circle cx="14.5" cy="10" r=".9"/><circle cx="12.5" cy="14.5" r=".9"/><circle cx="8.8" cy="13.8" r=".9"/>',
  other:'<path d="M7 3v7M5 3v4.5a2 2 0 0 0 4 0V3M7 10v11"/><path d="M17 21V3c-2 1.5-3 4-3 8h3"/>'};
const catIcon=(id,sz=18)=>`<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CATI[id]||CATI.other}</svg>`;
function catColor(id){const i=CATS.findIndex(c=>c[0]===id);return CATCOL[i<0?7:i]}
function guessCat(name){
  const n=String(name||'');
  const T=[['snack',/餅乾|蛋糕|甜點|巧克力|糖果|冰淇淋|洋芋片|甜甜圈|泡芙|布丁|爆米花/],
    ['dairy',/牛奶|優格|起司|乳酪|奶昔|鮮奶/],
    ['drink',/茶|咖啡|可樂|汽水|果汁|豆漿|飲料|奶茶|湯/],
    ['fruit',/蘋果|香蕉|橘子|葡萄|西瓜|芭樂|奇異果|水果|莓|鳳梨|芒果/],
    ['veg',/青菜|花椰菜|菠菜|筍|菇類|蔬菜|絲瓜|苦瓜|豆芽|海帶|木耳/],
    ['protein',/雞|豬|牛|魚|蝦|蛋|豆腐|肉|排骨|火腿|培根|鮭魚|鯛魚|香腸/],
    ['staple',/飯|麵|粥|吐司|麵包|饅頭|水餃|麵線|蛋餅|煎餅|蔥油餅|刈包|漢堡|三明治|壽司|義大利麵|燕麥|玉米/]];
  for(const[c,re]of T)if(re.test(n))return c;return'other';
}
function foodIcon(f){const c=f.cat||guessCat(f.name),col=catColor(c);return`<span class="fic" style="background:color-mix(in srgb,${col} 16%,var(--card));color:${col}">${catIcon(c,20)}</span>`}
function mchips(f){return(f.protein_g?`<span class="mchip p">蛋${f.protein_g}</span>`:'')+(f.carb_g!=null?`<span class="mchip c">碳${f.carb_g}</span>`:'')+(f.fat_g!=null?`<span class="mchip f">脂${f.fat_g}</span>`:'')}
var curFcat='';
function renderFcatf(){
  $('#fcatf').innerHTML=['<button class="pill'+(curFcat?'':' on')+'" data-fcf="">全部</button>']
    .concat(CATS.map(([id,l])=>`<button class="pill${curFcat===id?' on':''}" data-fcf="${id}" style="display:inline-flex;gap:6px">${catIcon(id,16)}${l}</button>`)).join('');
}
$('#fcatf').onclick=e=>{const b=e.target.closest('[data-fcf]');if(!b)return;curFcat=b.dataset.fcf;renderFcatf();renderFoods()};
// 常見食物：衛福部食藥署「食品營養成分資料庫」換算成常用份量（data-tw-foods.js，用到才載入）
function loadTwFoods(){if(window.TW_FOODS)return Promise.resolve(window.TW_FOODS);return new Promise((ok,no)=>{const s=document.createElement('script');s.src='data-tw-foods.js';s.onload=()=>ok(window.TW_FOODS||[]);s.onerror=()=>no(Error('常見食物資料載入失敗'));document.head.appendChild(s)})}
async function addTwFoods(){
  try{const L=await loadTwFoods(),have=new Set(db.foods.map(f=>f.name));let n=0;
    L.forEach(f=>{if(!have.has(f.name)){db.foods.push({id:newId('f'),used:0,...f});n++}});
    db.twSeed=1;save();renderFoods();toast(n?`已加入 ${n} 種常見食物`:'常見食物都已經在食物庫裡了')}
  catch(e){toast(e.message)}
}
function renderTwSeed(){
  const el=$('#twseed');if(db.twSeed){el.innerHTML='';return}
  el.innerHTML=`<div class="callout" style="margin-bottom:12px"><b>加入常見食物？</b><p style="margin:6px 0 10px">一次加入 85 種常見食物：白飯、雞蛋、雞胸肉、豆腐、蔬菜水果、手搖飲等。數字來自衛福部食藥署「食品營養成分資料庫」，份量都標示公克數。已經有同名的食物不會重複加入。</p><div class="row"><button class="sm" id="twyes">加入</button><button class="alt sm" id="twno">不用了</button></div></div>`;
  $('#twyes').onclick=addTwFoods;$('#twno').onclick=()=>{db.twSeed='no';save();renderFoods()};
}
$('#twadd').onclick=addTwFoods;
function renderFoods(){
  renderTwSeed();$('#twadd').hidden=!db.twSeed;
  const q=$('#fq').value.trim(),all=foodMatch(q).filter(f=>!curFcat||(f.cat||guessCat(f.name))===curFcat),sh=all.slice(0,30);
  $('#flist').innerHTML=sh.length?`<div class="grp">${sh.map(f=>`<button class="frow" data-f="${f.id}">${foodIcon(f)}<span class="mmain"><b>${esc(f.name)}</b><span class="chipr"><span class="mut">${esc(f.unit)}</span>　${mchips(f)}</span></span><span class="mk"><b>${f.kcal}</b><span>大卡</span></span></button>`).join('')}</div>`
    :`<div class="empty"><b>${db.foods.length?'找不到符合的食物':'食物庫是空的'}</b><span class="mut">${db.foods.length?'換個關鍵字或分類試試':'按右上角「＋」新增常吃的食物'}</span></div>`;
  if(all.length>30)$('#flist').insertAdjacentHTML('beforeend',`<p class="mut">共 ${all.length} 項，輸入關鍵字可縮小範圍</p>`);
  document.querySelectorAll('#flist [data-f]').forEach(b=>b.onclick=()=>openFoodSheet(db.foods.find(f=>f.id===b.dataset.f)));
  renderFcatf();
}
var fCat='';
function renderFcatSheet(){$('#fcat').innerHTML=CATS.map(([id,l])=>`<button class="pill${fCat===id?' on':''}" data-fc="${id}" style="flex-direction:column;gap:2px;min-height:52px">${catIcon(id,18)}${l}</button>`).join('')}
$('#fcat').onclick=e=>{const b=e.target.closest('[data-fc]');if(!b)return;fCat=b.dataset.fc;renderFcatSheet()};
function openFoodSheet(f){
  fe=f&&f.id||null;$('#fdt').textContent=fe?'編輯食物':'新增食物';
  $('#fn').value=f?.name||'';$('#fu').value=f?.unit||'1份';$('#fk').value=f?.kcal??'';$('#fp').value=f?.protein_g??'';$('#fc').value=f?.carb_g??'';$('#ff').value=f?.fat_g??'';$('#fb').value=f?.fiber_g??'';
  fCat=f?.cat||(f?.name?guessCat(f.name):'');renderFcatSheet();$('#fd').hidden=!fe;
  $('#fsrc').hidden=!f?.src;$('#fsrc').textContent=f?.src?'資料來源：'+f.src:'';
  openSheet($('#fdlg'));
}
$('#faddbtn').onclick=()=>openFoodSheet(null);
$('#fx').onclick=()=>closeSheet($('#fdlg'));
$('#fa').onclick=async()=>{
  const name=$('#fn').value.trim();if(!name)return toast('請先輸入食物名稱');toast('AI 估算中…');
  try{const t=await ai(`請估算這個食物的熱量與營養：${name}，份量：${$('#fu').value||'1份'}。只回傳 JSON：{"kcal":0,"protein_g":0,"carb_g":0,"fat_g":0,"fiber_g":0}`,'你是營養師，以台灣常見食物與份量為準，給合理的中間值。',300,true);
    const o=cleanNut(parseJson(t));$('#fk').value=o.kcal;$('#fp').value=o.protein_g??'';$('#fc').value=o.carb_g??'';$('#ff').value=o.fat_g??'';$('#fb').value=o.fiber_g??'';if(!fCat){fCat=guessCat(name);renderFcatSheet()}toast('已估算，請確認數字再儲存')}catch(e){toast('估算失敗：'+e.message)}
};
$('#fs').onclick=()=>{
  const name=$('#fn').value.trim(),kcal=+$('#fk').value;
  if(!name||$('#fk').value===''||!(kcal>=0))return toast('請填名稱與熱量');
  const nv=id=>$('#'+id).value===''?null:+$('#'+id).value;const rec={name,unit:$('#fu').value.trim()||'1份',kcal:Math.round(kcal),protein_g:+$('#fp').value||0,carb_g:nv('fc'),fat_g:nv('ff'),fiber_g:nv('fb'),cat:fCat||guessCat(name)};
  const ex=fe&&db.foods.find(f=>f.id===fe);
  if(ex){if(ex.src&&['unit','kcal','protein_g','carb_g','fat_g','fiber_g'].some(k=>String(ex[k]??'')!==String(rec[k]??'')))delete ex.src;Object.assign(ex,rec)}else db.foods.push({id:newId('f'),used:0,...rec});
  save();closeSheet($('#fdlg'));renderFoods();toast('已儲存到食物庫');
};
$('#fd').onclick=()=>{
  const i=db.foods.findIndex(f=>f.id===fe);if(i<0)return;const f=db.foods[i];db.foods.splice(i,1);save();closeSheet($('#fdlg'));renderFoods();
  toast(`已刪除「${f.name}」`,{label:'復原',fn:()=>{db.foods.splice(Math.min(i,db.foods.length),0,f);save();renderFoods();toast('已復原')}});
};
$('#fq').oninput=renderFoods;
function saveToLibrary(a){showTab('food');setFt('food');openFoodSheet({name:a.name,unit:'1份',kcal:a.kcal,protein_g:a.protein_g,carb_g:a.carb_g,fat_g:a.fat_g,fiber_g:a.fiber_g})}


// ======================= 從食物庫挑選（新增餐點、固定餐共用） =======================
// 平常只顯示一排「常用」小標籤；打字才出現搜尋結果；「全部」開專門的挑選視窗（可按分類篩選、連續加好幾樣）。
const qfmt=q=>String(+(+q).toFixed(2));
function libMount(box,getItems,onChange){
  box.innerHTML=`<div class="libq"><input class="libs" type="search" placeholder="搜尋食物庫" enterkeyhint="search" autocomplete="off"><button type="button" class="alt sm liball"></button></div><div class="libpick"></div><div class="libsel"></div>`;
  const st={box,getItems,onChange,inp:box.querySelector('.libs')};
  st.inp.addEventListener('input',()=>libRender(st));
  box.querySelector('.liball').onclick=()=>openPicker(st);
  box.addEventListener('click',e=>{
    const a=e.target.closest('[data-la]');if(a){libAdd(st,a.dataset.la);return}
    const d=e.target.closest('[data-ld]');if(d){libQty(st,+d.dataset.ld,-.5);return}
    const i=e.target.closest('[data-li]');if(i){libQty(st,+i.dataset.li,.5);return}
    const r=e.target.closest('[data-lr]');if(r){st.getItems().splice(+r.dataset.lr,1);libRender(st);st.onChange()}
  });
  box.addEventListener('change',e=>{const q=e.target.closest('[data-lq]');if(q){const it=st.getItems()[+q.dataset.lq];it.qty=Math.max(0,+q.value||0);libRender(st);st.onChange()}});
  return st;
}
function libReset(st){st.inp.value='';libRender(st)}
function libAdd(st,id){const items=st.getItems(),f=db.foods.find(x=>x.id===id);if(!f)return;const e=items.find(x=>x.id===id);if(e)e.qty+=1;else items.push({...f,qty:1});libRender(st);st.onChange()}
function libQty(st,i,d){const it=st.getItems()[i];if(!it)return;it.qty=Math.max(.25,it.qty+d);libRender(st);st.onChange()}
const libCnt=(items,id)=>items.find(x=>x.id===id)?.qty||0;
// 精簡的一列：圖示、名稱、份量、熱量、右邊是「＋」或已選份數
function libRow(f,items,attr){const c=libCnt(items,f.id);return`<button type="button" class="lrow" data-${attr}="${f.id}">${foodIcon(f)}<span class="ln"><b>${esc(f.name)}</b><span>${esc(f.unit)}${f.protein_g?`・蛋白質 ${f.protein_g}g`:''}</span></span><span class="lk">${f.kcal}<small> 大卡</small></span><span class="lc${c?' on':''}">${c?'×'+qfmt(c):'+'}</span></button>`}
function libRender(st){
  const q=st.inp.value.trim(),items=st.getItems(),pick=st.box.querySelector('.libpick'),all=st.box.querySelector('.liball');
  all.hidden=!db.foods.length;all.textContent=`全部 ${db.foods.length}`;st.inp.hidden=!db.foods.length;
  if(!db.foods.length)pick.innerHTML='<p class="mut" style="margin:0">食物庫還是空的。到「食物庫」分頁新增常吃的食物，之後這裡點一下就能加入。</p>';
  else if(!q){
    const top=foodMatch('').slice(0,8);
    pick.innerHTML=`<div class="lhd">常用・點一下加入，再點一次加一份</div><div class="lchips">${top.map(f=>{const c=libCnt(items,f.id);return`<button type="button" class="lchip${c?' on':''}" data-la="${f.id}">${esc(f.name)}<small>${f.kcal}</small>${c?`<i>${qfmt(c)}</i>`:''}</button>`}).join('')}</div>`;
  }else{
    const res=foodMatch(q);
    pick.innerHTML=res.length?`<div class="lres">${res.slice(0,5).map(f=>libRow(f,items,'la')).join('')}</div>${res.length>5?`<p class="mut" style="margin:6px 2px 0">還有 ${res.length-5} 項，輸入更多字或按「全部」</p>`:''}`
      :`<p class="mut" style="margin:0">找不到「${esc(q)}」。可以直接寫在上面的說明裡，讓 AI 估算。</p>`;
  }
  const sel=st.box.querySelector('.libsel');
  sel.innerHTML=items.length?`<div class="lsel">${items.map((it,i)=>`<div class="lsr"><span class="ln"><b>${esc(it.name)}</b><span>${esc(it.unit)}・${Math.round(it.kcal*it.qty)} 大卡</span></span><div class="qstep"><button type="button" class="alt" data-ld="${i}" aria-label="減少">−</button><input type="number" min="0.25" step="0.25" inputmode="decimal" value="${qfmt(it.qty)}" data-lq="${i}" aria-label="份數"><button type="button" class="alt" data-li="${i}" aria-label="增加">+</button></div><button type="button" class="x" data-lr="${i}" aria-label="移除">×</button></div>`).join('')}</div>`:'';
}
// 全部食物挑選視窗
let fp={st:null,cat:''};
function openPicker(st){fp={st,cat:''};$('#fpq').value=st.inp.value.trim();renderPicker();openSheet($('#fpk'))}
function renderPicker(){
  const st=fp.st,items=st.getItems(),q=$('#fpq').value.trim(),cats=CATS.filter(([id])=>db.foods.some(f=>(f.cat||guessCat(f.name))===id));
  $('#fpc').innerHTML=cats.length>1?[`<button class="pill${fp.cat?'':' on'}" data-fpc="">全部</button>`].concat(cats.map(([id,l])=>`<button class="pill${fp.cat===id?' on':''}" data-fpc="${id}" style="display:inline-flex;gap:6px">${catIcon(id,16)}${l}</button>`)).join(''):'';
  const L=foodMatch(q).filter(f=>!fp.cat||(f.cat||guessCat(f.name))===fp.cat),sh=L.slice(0,80);
  $('#fpl').innerHTML=sh.length?`<div class="lres">${sh.map(f=>libRow(f,items,'pa')).join('')}</div>${L.length>80?`<p class="mut">共 ${L.length} 項，輸入關鍵字可縮小範圍</p>`:''}`:'<p class="mut">沒有符合的食物</p>';
  const n=items.length,k=Math.round(items.reduce((a,i)=>a+i.kcal*i.qty,0));
  $('#fpok').textContent=n?`完成（已選 ${n} 樣・${k} 大卡）`:'完成';
}
$('#fpq').addEventListener('input',renderPicker);
$('#fpc').onclick=e=>{const b=e.target.closest('[data-fpc]');if(b){fp.cat=b.dataset.fpc;renderPicker()}};
$('#fpl').onclick=e=>{const b=e.target.closest('[data-pa]');if(!b)return;const st=fp.st,items=st.getItems(),f=db.foods.find(x=>x.id===b.dataset.pa),ex=items.find(x=>x.id===f.id);if(ex)ex.qty+=1;else items.push({...f,qty:1});st.onChange();renderPicker()};
const fpDone=()=>{if(fp.st){fp.st.inp.value='';libRender(fp.st)}};
$('#fpok').onclick=$('#fpkx').onclick=()=>{closeSheet($('#fpk'));fpDone()};$('#fpk')._onDismiss=fpDone;

// ======================= 新增餐點 =======================
const mdTot=()=>md.items.reduce((a,i)=>({k:a.k+i.kcal*i.qty,p:a.p+(i.protein_g||0)*i.qty,c:a.c+(i.carb_g||0)*i.qty,f:a.f+(i.fat_g||0)*i.qty,b:a.b+(i.fiber_g||0)*i.qty}),{k:0,p:0,c:0,f:0,b:0});
function updSum(){const t=mdTot();$('#msum').textContent=md.items.length?`食物庫已選合計：${Math.round(t.k)} kcal｜蛋白質 ${Math.round(t.p)}g`:'';
  $('#mgo').textContent=(!md.img&&!$('#mdesc').value.trim()&&md.items.length)?'直接加入':'AI 分析'}
var mq=[];
const nowT=()=>new Date().toTimeString().slice(0,5);
function nextMeal(){const n=mq.shift();if(n)openMeal(n.img,n.d,n.t,mq.length,n.note)}
function openMeal(img,d,t,left,note){
  md={img,items:[]};$('#mdesc').value='';$('#mdate').max=today();$('#mdate').value=d||today();$('#mtime').value=t||nowT();
  $('#mdp')._upd();$('#msnack').checked=false;$('#mcnt').textContent=left?`　（還有 ${left} 張待處理）`:'';$('#mnote').textContent=note||'';const pv=$('#mpv');pv.hidden=!img;if(img)pv.src=img;
  libReset(mLib);updSum();mtpMark();openSheet($('#mdlg'));
}
$('#mdesc').oninput=updSum;
const mLib=libMount($('#mlib'),()=>md.items,updSum);
function dpInit(el,inp){
  const upd=()=>{const d=inp.value;if(!d){el.querySelector('.dl').textContent='請選日期';return}const t=today(),rel=d===t?'今天':d===addD(t,-1)?'昨天':d===addD(t,-2)?'前天':'',[,m,dd]=d.split('-');el.querySelector('.dl').textContent=`${rel?rel+' ':''}${+m}/${+dd}（${'日一二三四五六'[new Date(d+'T00:00').getDay()]}）`};
  const set=v=>{if(v>today())v=today();inp.value=v;upd()};
  el.onclick=e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.dd){const d=new Date((inp.value||today())+'T00:00');d.setDate(d.getDate()+ +b.dataset.dd);set(ymd(d))}
    else if(b.dataset.dset!==undefined){const d=new Date();d.setDate(d.getDate()-+b.dataset.dset);set(ymd(d))}};
  inp.max=today();inp.addEventListener('input',upd);inp.addEventListener('change',upd);el._upd=upd;
}
dpInit($('#mdp'),$('#mdate'));dpInit($('#gdp'),$('#gdate'));
$('#mtp').onclick=e=>{const b=e.target.closest('button');if(b){$('#mtime').value=b.dataset.tm;mtpMark()}};
$('#mtime').addEventListener('input',mtpMark);
function mtpMark(){const t=$('#mtime').value;$('#mtp').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.tm===t))}
// 點日期文字 → 打開系統日期選擇器
$('#mdlb').onclick=()=>{const i=$('#mdate');try{i.showPicker()}catch(e){i.focus();i.click()}};
// 相簿補登
var gdate=today(),guse=false;
function openGallery(lock){$('#gdate').value=lock||today();$('#gdp')._upd();$('#guse').checked=false;openSheet($('#gdlg'))}
$('#gx').onclick=()=>closeSheet($('#gdlg'));
$('#ggo').onclick=()=>{gdate=$('#gdate').value||today();guse=$('#guse').checked;closeSheet($('#gdlg'));$('#gal').click()};
$('#gal').onchange=async e=>{
  const fs=[...e.target.files];e.target.value='';if(!fs.length)return;toast('讀取照片中…');
  const L=[];let bad=0,why='';for(const f of fs){let lm=f.lastModified?new Date(f.lastModified):new Date();if(ymd(lm)>today())lm=new Date();
    try{L.push({img:await shrink(f),d:guse?ymd(lm):gdate,t:lm.toTimeString().slice(0,5),note:guse?'日期與時間已依照片檔案時間預填，請確認是否正確。':`已套用你選的日期 ${gdate}，時間請確認。`})}catch(err){bad++;why=err.message}}
  if(!L.length)return toast(why||'沒有可用的照片');
  if(bad)toast(`有 ${bad} 張照片無法讀取，已略過`);
  L.sort((a,b)=>(a.d+a.t).localeCompare(b.d+b.t));mq=L;nextMeal();
};
$('#cam').onchange=async e=>{const f=e.target.files[0];const lk=e.target.dataset.lock;delete e.target.dataset.lock;e.target.value='';if(!f)return;try{openMeal(await shrink(f),lk||undefined)}catch(err){toast(err.message)}};
// 補照片／換照片（attT = [日期, 餐點 id]）
var attT=null;
$('#att').onchange=async e=>{
  const f=e.target.files[0];e.target.value='';if(!f||!attT)return;const m=findMeal(attT[0],attT[1])?.m;if(!m)return;
  try{const im=await shrink(f),old=m.imgId;m.imgId=newId('i');await putImg(m.imgId,im);if(old)delImg(old);save();render();if($('#msd').open&&ms&&ms.id===m.id)openMealSheet(attT[0],m.id);toast('已補上照片')}catch(err){toast(err.message)}
};
$('#mx').onclick=()=>{closeSheet($('#mdlg'));nextMeal()};$('#mdlg')._onDismiss=()=>setTimeout(nextMeal,0);
$('#mgo').onclick=async()=>{
  const desc=$('#mdesc').value.trim(),items=md.items.filter(i=>i.qty>0),img=md.img;
  if(!img&&!desc&&!items.length)return toast('請拍照、輸入說明或選擇食物');
  let dkey=$('#mdate').value||today();if(dkey>today())dkey=today();
  const m={id:newId('m'),t:$('#mtime').value||nowT()};if($('#msnack').checked)m.snack=true;if(desc)m.desc=desc;
  if(items.length){m.items=items.map(({name,unit,qty,kcal,protein_g,carb_g,fat_g,fiber_g})=>({name,unit,qty,kcal,protein_g,carb_g,fat_g,fiber_g}));items.forEach(i=>{const f=db.foods.find(x=>x.id===i.id);if(f)f.used=(f.used||0)+1})}
  const tt=mdTot(),fromLib=()=>({name:items.map(i=>`${i.name}×${i.qty}`).join('、'),kcal:Math.round(tt.k),protein_g:Math.round(tt.p),...(items.every(i=>i.carb_g!=null)?{carb_g:Math.round(tt.c)}:{}),...(items.every(i=>i.fat_g!=null)?{fat_g:Math.round(tt.f)}:{}),fiber_g:Math.round(tt.b),note:'來自食物庫'});
  closeSheet($('#mdlg'));
  if(img){m.imgId=newId('i');await putImg(m.imgId,img)}
  day(dkey).meals.push(m);day(dkey).meals.sort(byT);
  if(!img&&!desc){m.ai=fromLib();save();render();toast(dkey===today()?'已加入':`已加入 ${dkey}`);if(dkey!==today())jumpTo(dkey);nextMeal();return}
  busy.add(m);save();render();toast(dkey===today()?'AI 分析中…':`已加入 ${dkey}，AI 分析中…`);const more=mq.length;nextMeal();if(!more&&dkey!==today())jumpTo(dkey);
  try{applyAI(m,await runMealAI(img,desc,items))}
  catch(err){toast('分析失敗：'+err.message+(items.length?'（已先用食物庫數字）':'，可點這餐手動填數字'));if(items.length)m.ai=fromLib()}
  busy.delete(m);save();render();
};
// ---------- AI 餐點辨識：逐項拆解、參考使用者自己的資料、不確定時提問 ----------
const MEAL_SYS='你是台灣的營養師，擅長從照片估算台灣常見餐點（便當、自助餐、麵店、小吃、早餐店、手搖飲、超商）。估算步驟：1) 列出畫面中每一樣食物；2) 用碗盤、餐具、便當盒、手等當比例尺，估計每樣的份量與克數（例如一般飯碗約 200g 白飯、便當的飯約 250g）；3) 把看不到的油、醬汁、勾芡、湯汁算進去（炒菜、炸物、滷味都要算油）；4) 依台灣食品營養成分資料庫的數值算出每一樣的營養素。估算要務實，不確定時取合理中間值。使用者提供的說明、指定的已知食物、常吃食物的數據、過去的修正，都優先於你對照片的推測。';
const MEAL_FMT='\n\n只回傳 JSON，格式：{"name":"這餐的簡短名稱","items":[{"name":"白飯","amount":"約1碗","grams":200,"kcal":280,"protein_g":5,"carb_g":62,"fat_g":1,"fiber_g":1}],"note":"一句話說明主要的不確定處","confidence":"high 或 medium 或 low","question":null}'
  +'\n規則：items 每一樣都要有完整數字；使用者指定的已知食物也要列在 items 裡。只有在你真的不確定、而且答案會讓總熱量差 20% 以上時，才把 question 設成 {"text":"一個簡短問題","options":["選項1","選項2"]}（例如飯量、有沒有吃完、飲料甜度），options 2～4 個、每個不超過 8 個字；否則 question 為 null。';
// 使用者自己的資料：常吃食物（食物庫）＋過去修正過的估算
function calibCtx(){
  const fs=foodMatch('').slice(0,25).map(f=>`${f.name}（${f.unit}）${f.kcal}kcal、蛋白質${f.protein_g||0}g`).join('；');
  const cs=(db.calib||[]).slice(-12).map(c=>c.part?`「${c.name}」裡的「${c.part}」：AI 估 ${c.from}，實際是 ${c.to}`:`「${c.name}」：AI 估 ${c.from} 大卡，實際是 ${c.to} 大卡`).join('\n');
  return(fs?`\n\n使用者常吃食物的實際數據（同樣的食物請直接採用這些數字）：${fs}`:'')+(cs?`\n\n使用者過去修正過的估算（代表這位使用者的份量習慣，類似的餐點請參考調整）：\n${cs}`:'');
}
const n0=v=>Math.max(0,Math.round(+v||0));
function partsTotal(parts){const t={kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0};parts.forEach(q=>{const x=q.x??1;t.kcal+=q.k*x;t.protein_g+=q.p*x;t.carb_g+=q.c*x;t.fat_g+=q.f*x;t.fiber_g+=q.b*x});Object.keys(t).forEach(k=>t[k]=Math.round(t[k]));return t}
// 回傳 {ai, q}：ai 是這餐的營養（含 parts 逐項），q 是 AI 想問使用者的問題（沒有就是 null）
async function runMealAI(img,desc,items,hints){
  const parts=[];if(img)parts.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:img.split(',')[1]}});
  parts.push({type:'text',text:(img?'請辨識這餐並估算份量與營養。':'請根據以下說明估算這餐的份量與營養。')
    +(desc?`\n使用者補充說明（請優先採用）：${desc}`:'')
    +(items.length?`\n使用者指定的已知食物（數字以此為準，其他有出現的食物再自行估算）：${items.map(i=>`${i.name}×${i.qty}（1 份＝${i.unit}，約 ${i.kcal}kcal、蛋白質 ${i.protein_g||0}g${i.carb_g!=null?`、碳水 ${i.carb_g}g`:''}${i.fat_g!=null?`、脂肪 ${i.fat_g}g`:''}）`).join('、')}`:'')
    +(hints?`\n使用者的補充或修正（請優先採用）：${hints}`:'')+calibCtx()+MEAL_FMT});
  const o=parseJson(await ai(parts,MEAL_SYS,1500,true));
  const L=(Array.isArray(o.items)?o.items:[]).filter(x=>x&&x.name).slice(0,15).map(x=>({n:String(x.name).slice(0,30),a:String(x.amount||'').slice(0,20),g:numOrNull(x.grams),k:n0(x.kcal),p:n0(x.protein_g),c:n0(x.carb_g),f:n0(x.fat_g),b:n0(x.fiber_g),x:1}));
  const tot=L.length?partsTotal(L):cleanNut(o);if(!(tot.kcal>0)&&!L.length)throw Error('AI 沒有估出熱量，請補充說明後再試');
  const conf=['high','medium','low'].includes(o.confidence)?o.confidence:undefined;
  const q=o.question&&o.question.text&&Array.isArray(o.question.options)&&o.question.options.length?{text:String(o.question.text).slice(0,60),opts:o.question.options.slice(0,4).map(x=>String(x).slice(0,12))}:null;
  return{ai:{name:String(o.name||desc||'餐點').slice(0,60),...tot,note:o.note?String(o.note).slice(0,120):undefined,...(L.length?{parts:L}:{}),...(conf?{conf}:{}),aiK:tot.kcal},q};
}
function applyAI(m,r){m.ai=r.ai;if(r.q)m.q=r.q;else delete m.q}
// 回答 AI 的問題 → 帶著答案重新估算
async function answerQ(k,id,i){
  const f=findMeal(k,id);if(!f||!f.m.q)return;const m=f.m,q=m.q;delete m.q;
  if(i<0){save();render();return}
  const img=m.imgId?await getImg(m.imgId).catch(()=>null):null;
  busy.add(m);save();render();toast('依你的回答重新估算…');
  try{applyAI(m,await runMealAI(img,m.desc||'',m.items||[],`問題「${q.text}」的答案是「${q.opts[i]}」`))}catch(e){toast('重新估算失敗：'+e.message)}
  busy.delete(m);save();render();
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-qa]');if(b){const[k,id,i]=b.dataset.qa.split('|');answerQ(k,id,+i)}});
function renderQs(){
  const L=[];for(let i=0;i<3;i++){const k=addD(today(),-i);(db.days[k]?.meals||[]).forEach(m=>{if(m.q&&!busy.has(m))L.push([k,m])})}
  $('#mqs').innerHTML=L.map(([k,m])=>`<div class="callout qcard"><b>AI 想確認：${esc(m.ai?.name||'這餐')}${k!==today()?`（${+k.slice(5,7)}/${+k.slice(8)}）`:''}</b><p>${esc(m.q.text)}</p><div class="pills">${m.q.opts.map((o,i)=>`<button class="pill" data-qa="${k}|${m.id}|${i}">${esc(o)}</button>`).join('')}<button class="pill" data-qa="${k}|${m.id}|-1" style="color:var(--mut)">不用了</button></div></div>`).join('');
}

// ======================= 餐點編輯視窗 =======================
var ms=null,msOrig=null,msParts=[];
function renderParts(note){
  const el=$('#se-parts');if(!msParts.length){el.innerHTML='';return}
  el.innerHTML=`<span class="lb">AI 拆解（調整份量，下面的數字會自動重算）</span><div class="lsel parts">${msParts.map((q,i)=>`<div class="lsr${q.x?'':' off'}"><span class="ln"><b>${esc(q.n)}</b><span>${esc(q.a||'')}${q.g?`・約 ${Math.round(q.g*(q.x||1))}g`:''}</span></span><div class="qstep"><button type="button" class="alt" data-pd="${i}" aria-label="減少">−</button><input type="number" min="0" step="0.25" inputmode="decimal" value="${qfmt(q.x)}" data-px="${i}" aria-label="份量倍數"><button type="button" class="alt" data-pi="${i}" aria-label="增加">+</button></div><span class="pk">${Math.round(q.k*q.x)}</span></div>`).join('')}</div>`
    +(note?`<p class="mut" style="margin:6px 2px 10px;font-size:13px">AI：${esc(note)}</p>`:'<div style="height:8px"></div>');
}
function partsToFields(){const t=partsTotal(msParts);[['k','kcal'],['p','protein_g'],['c','carb_g'],['f','fat_g'],['b','fiber_g']].forEach(([x,y])=>$('#se-'+x).value=t[y]);renderParts(curMeal()?.m.ai?.note)}
$('#se-parts').addEventListener('click',e=>{const d=e.target.closest('[data-pd]'),u=e.target.closest('[data-pi]');if(!d&&!u)return;const q=msParts[+(d||u).dataset[d?'pd':'pi']];q.x=Math.max(0,+(q.x+(d?-.25:.25)).toFixed(2));partsToFields()});
$('#se-parts').addEventListener('change',e=>{const i=e.target.dataset.px;if(i==null)return;msParts[+i].x=Math.max(0,+e.target.value||0);partsToFields()});
// 記住使用者的修正，之後辨識時給 AI 參考
function logCalib(a,v){
  const L=db.calib||(db.calib=[]),name=a.name||'餐點';let n=0;
  msParts.forEach(q=>{if(Math.abs(q.x-q.x0)>=.01){L.push({name,part:q.n,from:q.a||`${q.k} 大卡`,to:q.x?`${qfmt(q.x)} 倍（約 ${Math.round(q.k*q.x)} 大卡${q.g?`、${Math.round(q.g*q.x)}g`:''}）`:'沒有吃',at:today()});n++}});
  if(!n&&a.aiK&&v.kcal!=null&&Math.abs(v.kcal-msOrig.kcal)>Math.max(30,msOrig.kcal*.1))L.push({name,from:msOrig.kcal,to:Math.round(v.kcal),at:today()});
  if(L.length>40)L.splice(0,L.length-40);
}
function findMeal(k,id){const d=db.days[k];if(!d)return null;const i=d.meals.findIndex(x=>x.id===id);return i<0?null:{d,i,m:d.meals[i]}}
const curMeal=()=>ms&&findMeal(ms.k,ms.id);
async function openMealSheet(k,id){
  const f0=findMeal(k,id);if(!f0)return;const m=f0.m;ms={k,id};const a=m.ai||{},f=v=>v==null?'':v;
  $('#se-n').value=a.name||'';$('#se-d').value=m.desc||'';[['k','kcal'],['p','protein_g'],['c','carb_g'],['f','fat_g'],['b','fiber_g']].forEach(([x,y])=>$('#se-'+x).value=f(a[y]));
  $('#se-t').value=m.t||'';$('#se-s').checked=isSnack(m);msOrig={name:a.name||'',kcal:a.kcal,protein_g:a.protein_g,carb_g:a.carb_g,fat_g:a.fat_g,fiber_g:a.fiber_g};
  msParts=(a.parts||[]).map(q=>({...q,x0:q.x??1,x:q.x??1}));renderParts(a.note);
  $('#se-ph').textContent=m.imgId?'換照片':'補照片';$('#se-lib').hidden=!m.ai;
  const im=$('#se-img');im.hidden=!m.imgId;im.removeAttribute('src');
  openSheet($('#msd'));
  if(m.imgId){const v=await getImg(m.imgId).catch(()=>null);if(v)im.src=v;else im.hidden=true}
}
const sv=id=>{const v=$('#'+id).value;return v===''?null:+v};
const sheetVals=()=>({kcal:sv('se-k'),protein_g:sv('se-p'),carb_g:sv('se-c'),fat_g:sv('se-f'),fiber_g:sv('se-b')});
function sheetMeta(f){const m=f.m,d=$('#se-d').value.trim();if(d)m.desc=d;else delete m.desc;m.t=$('#se-t').value||m.t;m.snack=$('#se-s').checked;f.d.meals.sort(byT)}
$('#se-save').onclick=()=>{
  const f=curMeal();if(!f)return closeSheet($('#msd'));const m=f.m,v=sheetVals();
  if(v.kcal!=null&&!(v.kcal>=0))return toast('熱量數字不正確');
  const a=m.ai||(m.ai={});logCalib(a,v);
  Object.assign(a,{name:$('#se-n').value.trim()||a.name||'自訂餐點',kcal:v.kcal==null?null:Math.round(v.kcal),protein_g:v.protein_g,carb_g:v.carb_g,fat_g:v.fat_g,fiber_g:v.fiber_g,edited:true});
  if(msParts.length)a.parts=msParts.map(({x0,...q})=>q);
  sheetMeta(f);save();closeSheet($('#msd'));render();toast('已儲存');
};
$('#se-ai').onclick=async()=>{
  const f=curMeal();if(!f)return closeSheet($('#msd'));const m=f.m;
  const desc=$('#se-d').value.trim(),v=sheetVals(),items=m.items||[],img=m.imgId?await getImg(m.imgId).catch(()=>null):null;
  if(!img&&!desc&&!items.length)return toast('請先補照片或寫說明');
  const nm=$('#se-n').value.trim(),L={kcal:'熱量',protein_g:'蛋白質',carb_g:'碳水',fat_g:'脂肪',fiber_g:'纖維'};
  const pc=msParts.filter(q=>Math.abs(q.x-q.x0)>=.01).map(q=>q.x?`「${q.n}」是原本估計的 ${qfmt(q.x)} 倍`:`沒有吃「${q.n}」`);
  const hints=[nm&&nm!==msOrig.name?`名稱「${nm}」`:'',...pc,...(pc.length?[]:Object.keys(L).filter(k=>v[k]!=null&&v[k]!==msOrig[k]).map(k=>`${L[k]} ${v[k]}`))].filter(Boolean).join('、');
  sheetMeta(f);closeSheet($('#msd'));busy.add(m);save();render();toast('AI 重新辨識中…');
  try{applyAI(m,await runMealAI(img,desc,items,hints))}catch(err){toast('辨識失敗：'+err.message)}
  busy.delete(m);save();render();
};
$('#se-ph').onclick=()=>{if(ms){attT=[ms.k,ms.id];$('#att').click()}};
$('#se-lib').onclick=()=>{const m=curMeal()?.m;if(m?.ai){closeSheet($('#msd'));saveToLibrary(m.ai)}};
$('#se-del').onclick=()=>{if(ms){closeSheet($('#msd'));deleteMeal(ms.k,ms.id)}};
$('#se-x').onclick=()=>closeSheet($('#msd'));
// 刪除餐點：先從畫面移除，5 秒內可以「復原」；時間到才真的刪照片
function deleteMeal(k,id){
  const f=findMeal(k,id);if(!f)return;const{d,i,m}=f;d.meals.splice(i,1);let sk=false;if(m.rid){(d.skip??=[]).push(m.rid);sk=true}save();render();
  toast('已刪除這筆餐點',{label:'復原',fn:()=>{const dd=day(k);dd.meals.push(m);dd.meals.sort(byT);if(sk&&dd.skip){dd.skip=dd.skip.filter(x=>x!==m.rid);if(!dd.skip.length)delete dd.skip}save();render();toast('已復原')},done:()=>{if(m.imgId)delImg(m.imgId)}});
}
var dayLock=null;
function openAddFor(k){dayLock=k;openSheet($('#asd'))}
$('#fab').onclick=()=>{dayLock=null;openSheet($('#asd'))};
$('#ta-cam').onclick=()=>{closeSheet($('#asd'));if(dayLock)$('#cam').dataset.lock=dayLock;$('#cam').click()};
$('#ta-gal').onclick=()=>{closeSheet($('#asd'));openGallery(dayLock)};
$('#ta-txt').onclick=()=>{closeSheet($('#asd'));openMeal(null,dayLock||undefined);dayLock=null};
$('#ta-lbl').onclick=()=>{closeSheet($('#asd'));lbLock=dayLock;dayLock=null;$('#lblf').click()};
$('#ta-rt').onclick=()=>{closeSheet($('#asd'));showTab('food');setFt('rt')};

// ======================= 拍營養標示 =======================
// 直接讀包裝上的數字（不是估算），可記錄這餐並存到食物庫
var lbLock=null,lb=null;
const LB_PROMPT='這是台灣食品包裝上的「營養標示」照片。請「讀出」標示上的數字，不要估算或猜測。只回傳 JSON：'
 +'{"readable":true,"name":"商品名稱（照片裡看不到就用 null）","serving_size":每一份量的數字,"serving_unit":"公克 或 毫升","servings":本包裝含幾份（看不到用 null）,'
 +'"per_serving":{"kcal":0,"protein_g":0,"fat_g":0,"carb_g":0,"sugar_g":0,"fiber_g":null,"sodium_mg":0},"per_100":null}'
 +'\n規則：標示上有「每100公克／毫升」欄時，per_100 填同樣格式的物件；沒有就 null。標示上沒有的項目填 null。只有 kJ 時換算成大卡（除以 4.184）。照片不是營養標示或看不清楚時 readable 為 false。';
$('#lblf').onchange=async e=>{
  const f=e.target.files[0];e.target.value='';if(!f)return;
  let img;try{img=await shrink(f,1400,.85)}catch(err){return toast(err.message)}
  lb={img,st:'load'};lbRender();openSheet($('#lbd'));
  try{
    const o=parseJson(await ai([{type:'image',source:{type:'base64',media_type:'image/jpeg',data:img.split(',')[1]}},{type:'text',text:LB_PROMPT}],'你精確讀取食品營養標示的數字，絕不猜測。',800,true));
    if(o.readable===false)throw Error('看不清楚營養標示，請拍近一點、避免反光再試一次');
    const cv=x=>x&&typeof x==='object'?{k:numOrNull(x.kcal),p:numOrNull(x.protein_g),c:numOrNull(x.carb_g),f:numOrNull(x.fat_g),b:numOrNull(x.fiber_g),su:numOrNull(x.sugar_g),na:numOrNull(x.sodium_mg)}:null;
    let ps=cv(o.per_serving),p100=cv(o.per_100),size=numOrNull(o.serving_size),unit=/毫升|ml/i.test(o.serving_unit||'')?'毫升':'公克';
    if((!ps||ps.k==null)&&p100&&p100.k!=null){if(size){const r=size/100;ps=Object.fromEntries(Object.entries(p100).map(([k,v])=>[k,v==null?null:+(v*r).toFixed(1)]))}else{ps=p100;size=100}}
    if(!ps||ps.k==null)throw Error('讀不到熱量，請確認照片裡有完整的營養標示');
    const sv=numOrNull(o.servings);
    lb={img,st:'ok',name:o.name?String(o.name).slice(0,40):'',size,unit,servings:sv&&sv>0?sv:null,ps,qty:sv&&sv>0&&sv<=4?sv:1,lib:true,snack:false};
  }catch(err){lb={img,st:'err',msg:err.message}}
  lbRender();
};
function lbRender(){
  const c=$('#lbc');if(!lb)return;
  if(lb.st==='load'){c.innerHTML=`<img class="lbimg" src="${lb.img}" alt="營養標示照片"><p class="mut" style="text-align:center">讀取標示中…</p>`;return}
  if(lb.st==='err'){c.innerHTML=`<img class="lbimg" src="${lb.img}" alt=""><div class="callout warn">${esc(lb.msg)}</div><div class="row"><button style="flex:1" id="lbre">重拍</button><button class="alt" id="lbno">取消</button></div>`;
    $('#lbre').onclick=()=>{closeSheet($('#lbd'));$('#lblf').click()};$('#lbno').onclick=()=>closeSheet($('#lbd'));return}
  const P=lb.ps,q=lb.qty,r=v=>v==null?'-':Math.round(v*q*10)/10,row=(l,v,u)=>v==null?'':`<tr><td>${l}</td><td>${Math.round(v*10)/10} ${u}</td></tr>`;
  const sz=lb.size?`每份 ${lb.size} ${lb.unit}`:'每份',half=lb.servings&&lb.servings>1?lb.servings/2:null;
  c.innerHTML=`<img class="lbimg" src="${lb.img}" alt=""><label>名稱<input id="lbn" value="${esc(lb.name)}" placeholder="例如：義美小泡芙"></label>
   <p class="mut" style="margin:0 2px">${sz}${lb.servings?`・本包裝 ${qfmt(lb.servings)} 份`:''}（以下是每份的數字）</p>
   <table class="lbt">${row('熱量',P.k,'大卡')}${row('蛋白質',P.p,'g')}${row('脂肪',P.f,'g')}${row('碳水化合物',P.c,'g')}${row('　糖',P.su,'g')}${row('膳食纖維',P.b,'g')}${row('鈉',P.na,'mg')}</table>
   <span class="lb">吃了多少</span><div class="row" style="align-items:center;gap:10px"><div class="qstep"><button type="button" class="alt" id="lbm" aria-label="減少">−</button><input type="number" min="0.25" step="0.25" inputmode="decimal" id="lbq" value="${qfmt(q)}" aria-label="份數"><button type="button" class="alt" id="lbp" aria-label="增加">+</button></div><span>份</span>
   ${lb.servings?`<div class="pills" style="margin:0">${half?`<button class="pill sm" data-lq="${half}">半包</button>`:''}<button class="pill sm" data-lq="${lb.servings}">整包</button></div>`:''}</div>
   <div class="lbtot">共 <b>${r(P.k)}</b> 大卡・蛋白質 ${r(P.p)}g・碳水 ${r(P.c)}g・脂肪 ${r(P.f)}g</div>
   <label class="snk" style="margin:4px 0"><input type="checkbox" id="lbs" ${lb.snack?'checked':''}><span>點心零食</span></label>
   <label class="snk" style="margin:4px 0 12px"><input type="checkbox" id="lbl" ${lb.lib?'checked':''}><span>同時存到食物庫（下次直接選）</span></label>
   <div class="stk"><div class="row"><button style="flex:1" id="lbok">記錄這餐</button><button class="alt" id="lbno">取消</button></div></div>`;
  const setQ=v=>{lb.name=$('#lbn').value;lb.qty=Math.max(.25,+(+v).toFixed(2)||1);lbRender()};
  $('#lbq').onchange=e=>setQ(e.target.value);$("#lbm").onclick=()=>setQ(lb.qty-.5);$("#lbp").onclick=()=>setQ(lb.qty+.5);
  c.querySelectorAll('[data-lq]').forEach(b=>b.onclick=()=>setQ(b.dataset.lq));
  $('#lbs').onchange=e=>lb.snack=e.target.checked;$('#lbl').onchange=e=>lb.lib=e.target.checked;
  $('#lbno').onclick=()=>closeSheet($('#lbd'));$('#lbok').onclick=lbSave;
}
async function lbSave(){
  const name=$('#lbn').value.trim()||'包裝食品',P=lb.ps,q=lb.qty,k=lbLock||today(),z=v=>v==null?0:v;
  const part={n:name,a:lb.size?`每份 ${lb.size}${lb.unit==='毫升'?'ml':'g'}`:'1 份',g:lb.size&&lb.unit==='公克'?lb.size:null,k:z(P.k),p:z(P.p),c:z(P.c),f:z(P.f),b:z(P.b),x:q};
  const tot=partsTotal([part]);
  const m={id:newId('m'),t:nowT(),ai:{name:q===1?name:`${name}×${qfmt(q)}`,...tot,note:'依營養標示',label:true,parts:[part]}};if(lb.snack)m.snack=true;
  m.imgId=newId('i');await putImg(m.imgId,lb.img);
  day(k).meals.push(m);day(k).meals.sort(byT);
  if(lb.lib){const unit=lb.size?`1份(${lb.size}${lb.unit==='毫升'?'ml':'g'})`:'1份',rec={name,unit,kcal:Math.round(z(P.k)),protein_g:+z(P.p).toFixed(1),carb_g:P.c,fat_g:P.f,fiber_g:P.b,cat:lb.snack?'snack':guessCat(name)};
    const ex=db.foods.find(f=>f.name===name);if(ex)Object.assign(ex,rec);else db.foods.push({id:newId('f'),used:1,...rec})}
  save();closeSheet($('#lbd'));render();toast(lb.lib?'已記錄，也存到食物庫了':'已記錄');lbLock=null;if(k!==today())jumpTo(k);
}
$('#lbx').onclick=()=>closeSheet($('#lbd'));

// ======================= 健康數據與目標計算 =======================
const RD=['steps','distance','calories','basalCalories','totalCalories','heartRate','restingHeartRate','heartRateVariability','oxygenSaturation','respiratoryRate','bodyTemperature','bloodGlucose','bloodPressure','weight','bodyFat','height','sleep','flightsClimbed','exerciseTime','workouts'];
const SPEC=[{n:'步數',t:'steps',how:'sum',top:'steps'},{n:'體重',t:'weight',how:'last',top:'weight'},
 {n:'距離',t:'distance',how:'sum',k:'distanceKm',f:v=>v/1000},{n:'爬樓',t:'flightsClimbed',how:'sum',k:'floors'},{n:'運動時間',t:'exerciseTime',how:'sum',k:'exMin'},
 {n:'平均心率',t:'heartRate',how:'avg',k:'hr'},{n:'靜息心率',t:'restingHeartRate',how:'avg',k:'rhr'},{n:'HRV',t:'heartRateVariability',how:'avg',k:'hrv'},
 {n:'血氧',t:'oxygenSaturation',how:'avg',k:'spo2',pct:1},{n:'呼吸率',t:'respiratoryRate',how:'avg',k:'resp'},{n:'體溫',t:'bodyTemperature',how:'avg',k:'temp'},
 {n:'血糖',t:'bloodGlucose',how:'avg',k:'glucose'},{n:'體脂',t:'bodyFat',how:'last',k:'fat',pct:1}];
const HL={sleep:['睡眠','小時'],distanceKm:['距離','公里'],floors:['爬樓','層'],exMin:['運動時間','分鐘'],hr:['平均心率','bpm'],rhr:['靜息心率','bpm'],hrv:['HRV','ms'],spo2:['血氧','%'],resp:['呼吸率','次/分'],temp:['體溫','°C'],glucose:['血糖',''],fat:['體脂','%'],bp:['血壓','mmHg']};
const hxItems=d=>{const h=d.h||{},p=Object.entries(h).filter(([k])=>HL[k]).map(([k,v])=>[HL[k][0],`${v}${HL[k][1]}`]);if(h.wk?.length)p.push(['運動',h.wk.map(w=>`${wkName(w.n)} ${w.min}分${w.kcal?`/${w.kcal}kcal`:''}`).join('、')]);return p};
const hxHtml=d=>{const p=hxItems(d);return p.length?`<div class="hx">${p.map(([a,b])=>`<span>${esc(a)} <b>${esc(b)}</b></span>`).join('')}</div>`:''};
const hxText=d=>{const p=hxItems(d);return p.length?p.map(([a,b])=>a+b).join('、')+'｜':''};
function targets(k){
  const p=db.p,w=curWeight(),h=p.ht,age=ageNow(),male=p.sx==='m';let r={};
  if(w&&h&&age){
    const bmr=10*w+6.25*h-5*age+(male?5:-161),pal0=+p.act||1.375,losing=!p.wt||w>p.wt,exk=k&&db.days[k]?.ex,palD=exk&&PALD[exk]?PALD[exk]:pal0;
    let rate=+p.rate||.5,autoNote='';
    if(p.rate==='auto'){const left=p.dt&&p.dt>today()?(new Date(p.dt)-Date.now())/864e5/7:0;rate=p.wt&&w>p.wt&&left>0?(w-p.wt)/left:.5;
      if(rate>1){autoNote=`依目標日期需要每週瘦 ${rate.toFixed(2)} 公斤，超過安全範圍，已限制在 1 公斤`;rate=1}else if(rate<.1)rate=.1}
    const adjv=losing?p.kadj||0:0,want=losing?rate*7700/7-adjv:0,capped=want>1000,deficitWant=Math.min(want,1000);
    const floorK=Math.ceil(Math.max(bmr,male?1500:1200)/10)*10,ref=p.wt&&p.wt<w?p.wt:w;
    const mk=pal=>{const tdee=bmr*pal,raw=tdee-deficitWant,kcal=Math.max(floorK,Math.round(raw/10)*10);return{tdee,kcal,floored:raw<floorK,deficit:Math.max(0,Math.round(tdee-kcal))}};
    const A=mk(pal0),B=exk?mk(palD):A,kcal=B.kcal;
    const mac=(kc,pIn,fIn)=>{let pr=Math.max(Math.round(.8*ref),Math.min(pIn??Math.round(1.6*ref),Math.round(.35*kc/4),Math.round(2*w))),ft=fIn==null?Math.round(.27*kc/9):Math.min(Math.max(fIn,Math.round(.2*kc/9)),Math.round(.3*kc/9)),cb=(kc-pr*4-ft*9)/4;
      if(cb<100){ft=Math.round(.2*kc/9);cb=(kc-pr*4-ft*9)/4}if(cb<100){pr=Math.max(Math.round(.8*ref),Math.floor((kc-400-ft*9)/4));cb=(kc-pr*4-ft*9)/4}return{pr,ft,cb:Math.max(0,Math.round(cb))}};
    const base=mac(A.kcal),M=exk?mac(kcal,base.pr,base.ft):base;
    r={kcal,p:M.pr,f:M.ft,c:M.cb,fib:Math.min(35,Math.max(25,Math.round(14*kcal/1000))),bmr:Math.round(bmr),tdee:Math.round(B.tdee),pal:palD,deficit:B.deficit,floored:B.floored,floorK,capped,autoNote,rateEff:B.deficit*7/7700,adj:adjv,losing,
       pct:{p:Math.round(M.pr*400/kcal),c:Math.round(M.cb*400/kcal),f:Math.round(M.ft*900/kcal)},auto:true,ex:exk||null,exDelta:exk?kcal-A.kcal:0,usual:A.kcal};
  }
  const o=v=>+v>0?+v:null,m={kcal:o(p.tk),p:o(p.tp),c:o(p.tc),f:o(p.tf),fib:o(p.tb)};
  Object.keys(m).forEach(f=>{if(m[f]){r[f]=m[f];r.custom=true}});
  return r.kcal||r.p||r.c||r.f||r.fib?r:null;
}
function measuredTdee(){const v=[...Array(14)].map((_,i)=>db.days[ymd(new Date(Date.now()-i*864e5))]?.kcalOut).filter(x=>x>0);return v.length>=7?Math.round(avg(v)):null}
function nutSum(days){
  const t={kcal:0,p:0,c:0,f:0,fib:0},miss={c:0,f:0},n={meals:0,days:0};
  days.forEach(d=>{let any=0;(d.meals||[]).forEach(m=>{const a=m.ai;if(!a)return;any=1;n.meals++;t.kcal+=a.kcal||0;t.p+=a.protein_g||0;t.fib+=a.fiber_g||0;
    if(a.carb_g==null)miss.c++;else t.c+=a.carb_g;if(a.fat_g==null)miss.f++;else t.f+=a.fat_g});n.days+=any});
  return{t,miss,n};
}
function nutBars(t,tg){
  return[['kcal','熱量','大卡',1],['p','蛋白質','g',0],['c','碳水','g',1],['f','脂肪','g',1],['fib','膳食纖維','g',0]].map(([k,l,u,cap])=>{
    const v=Math.round(t[k]),g=tg?.[k],pct=g?Math.min(100,v/g*100):0,over=g&&cap&&v>g*1.05;
    return`<div class="nr"><div class="nrh"><span>${l}</span><span><b>${v}</b>${g?` / ${g}`:''} ${u}${g?`<span class="mut">（${Math.round(v/g*100)}%）</span>`:''}</span></div>${g?`<div class="pbar thin"><i class="${over?'ov':''}" ${aw('n7'+k,pct)}></i></div>`:''}</div>`}).join('');
}
function nutLine(d){const{t,n}=nutSum([d]);if(!n.meals)return'';return`<div class="hx"><span>攝取 <b>${Math.round(t.kcal)} 大卡</b></span><span>蛋白質 <b>${Math.round(t.p)}g</b></span><span>碳水 <b>${Math.round(t.c)}g</b></span><span>脂肪 <b>${Math.round(t.f)}g</b></span><span>纖維 <b>${Math.round(t.fib)}g</b></span></div>`}
function nutDig(d){const{t,n}=nutSum([d]);return n.meals?`（蛋白質${Math.round(t.p)}g/碳水${Math.round(t.c)}g/脂肪${Math.round(t.f)}g/纖維${Math.round(t.fib)}g）`:''}
function tgLine(){const t=targets();return t&&t.kcal?`\n${t.bmr?`基礎代謝${t.bmr}kcal、每日總消耗${t.tdee}kcal。`:''}每日營養目標：熱量${t.kcal}kcal、蛋白質${t.p??'-'}g、碳水${t.c??'-'}g、脂肪${t.f??'-'}g、纖維${t.fib??'-'}g。`:''}
const NEEDSET='<p class="mut" style="margin:0">到「設定 → 每日營養目標」填入性別、生日、活動量（身高、體重也要有），就能算出你每天需要的熱量與營養。</p><button class="alt sm" data-gonut="1" style="margin-top:8px">前往設定</button>';
function renderNut7(){
  const tg=targets(),ds=[...Array(7)].map((_,i)=>db.days[ymd(new Date(Date.now()-i*864e5))]||{meals:[]}),s7=nutSum(ds),nd=s7.n.days,el=$('#nut7');
  if(!nd)el.innerHTML='<p class="mut" style="margin:0">近 7 天還沒有飲食紀錄。</p>';
  else if(!tg)el.innerHTML=NEEDSET;
  else{const av={},tgs=[...Array(7)].map((_,i)=>ymd(new Date(Date.now()-i*864e5))).filter(k=>(db.days[k]?.meals||[]).some(m=>m.ai)).map(k=>targets(k)||tg),ta={};Object.keys(s7.t).forEach(k=>av[k]=s7.t[k]/nd);['kcal','p','c','f','fib'].forEach(f=>{const v=tgs.map(x=>x[f]).filter(Boolean);ta[f]=v.length?Math.round(avg(v)):tg[f]});el.innerHTML=`<p class="mut" style="margin:0 0 4px">近 7 天有 ${nd} 天有紀錄，平均每天：</p>`+nutBars(av,ta);animate(el)}
}
document.addEventListener('click',e=>{if(e.target.closest('[data-gonut]')){showTab('set');$('#nutgrp').open=true;setTimeout(()=>$('#nutgrp').scrollIntoView({behavior:'smooth',block:'start'}),50)}});
function renderTsug(){
  const tg=targets(),a=ageNow(),md_=measuredTdee(),kv=(l,v)=>`<div class="kv"><span>${l}</span><b>${v}</b></div>`;let h;
  if(tg&&tg.auto){
    h=`<b>每天建議吃 ${tg.kcal} 大卡</b>`+kv(`基礎代謝 BMR`,`${tg.bmr} 大卡`)+kv(`每日總消耗 TDEE（BMR × ${tg.pal}）`,`${tg.tdee} 大卡`)
      +kv('每日熱量缺口',tg.losing?`${tg.deficit} 大卡`:'0（維持體重）')+kv('預估每週變化',tg.losing?`約 -${tg.rateEff.toFixed(2)} 公斤`:'維持')
      +`<div style="margin-top:8px">蛋白質 ${tg.p}g（${tg.pct.p}%）・碳水 ${tg.c}g（${tg.pct.c}%）・脂肪 ${tg.f}g（${tg.pct.f}%）・纖維 ${tg.fib}g</div>`;
    const n=[];
    if(tg.floored)n.push(`熱量已降到下限 ${tg.floorK}（基礎代謝），想瘦快一點可以增加活動量。`);
    if(tg.capped)n.push('已限制在每天缺口 1000 大卡內。');
    if(tg.autoNote)n.push(tg.autoNote+'。');
    if(tg.adj)n.push(`已微調 ${tg.adj} 大卡。`);
    if(tg.custom)n.push('部分數值使用自訂值。');
    if(tg.kcal<tg.bmr)n.push('<b>目標低於基礎代謝，不建議長期這樣吃。</b>');
    if(md_)n.push(`手錶實測近 14 天消耗約 ${md_} 大卡（僅供參考）。`);
    h+=`<div class="mut" style="font-size:13px;margin-top:8px">${n.join('<br>')}</div>`;
  }else h=tg?'目前使用你自訂的目標。':'還缺資料：需要身高、生日（或年齡）、體重。';
  $('#tsug').innerHTML=h;
  $('#agetxt').textContent=db.p.bd?(a?`目前 ${a} 歲，之後會自動更新`:'生日不正確'):(db.p.ag?`尚未填生日，暫時使用年齡 ${db.p.ag} 歲`:'');$('#kreset').hidden=!db.p.kadj;
}
function ageNow(){const p=db.p;if(p.bd){const b=new Date(p.bd+'T00:00'),n=new Date();let a=n.getFullYear()-b.getFullYear();const m=n.getMonth()-b.getMonth();if(m<0||(m===0&&n.getDate()<b.getDate()))a--;return a>0&&a<120?a:null}return p.ag||null}
function curWeight(){
  const ws=[...Array(7)].map((_,i)=>db.days[ymd(new Date(Date.now()-i*864e5))]?.weight).filter(Boolean);
  if(ws.length)return +avg(ws).toFixed(1);
  const ks=Object.keys(db.days).filter(k=>db.days[k].weight).sort();return ks.length?db.days[ks.at(-1)].weight:(db.p.w0||null);
}
function actSug(){
  const st=[...Array(28)].map((_,i)=>db.days[ymd(new Date(Date.now()-i*864e5))]?.steps).filter(v=>v>0);
  if(st.length<14)return null;const a=avg(st);return{avg:Math.round(a),lv:a<5000?'1.2':a<7500?'1.375':a<10000?'1.55':'1.725'};
}
function plateau(){
  const tg=targets();if(!tg||!tg.auto||!tg.deficit)return null;
  if((db.p.snz||'')>today()||(db.p.kadj||0)<=-300)return null;if(db.p.kadjAt&&db.p.kadjAt>ymd(new Date(Date.now()-14*864e5)))return null;
  const win=i=>{const w=[...Array(7)].map((_,j)=>db.days[ymd(new Date(Date.now()-(i*7+j)*864e5))]?.weight).filter(Boolean);return w.length>=3?avg(w):null};
  const a=win(0),b=win(1),c=win(2);if(a==null||b==null||c==null)return null;
  const actual=(c-a)/2,planned=tg.deficit*7/7700;if(!(actual<planned*.4&&actual<.15))return null;
  let logged=0;for(let i=0;i<21;i++)if((db.days[ymd(new Date(Date.now()-i*864e5))]?.meals||[]).some(m=>m.ai))logged++;
  return{actual,planned,logged,tg};
}
function renderTip(){
  const el=$('#tip'),r=plateau();if(!r){el.hidden=true;return}
  let h=`<b>體重進度提醒</b><p style="margin:6px 0">最近 3 週平均每週體重只變化 ${Math.max(0,r.actual).toFixed(2)} 公斤，低於預期的 ${r.planned.toFixed(2)} 公斤。</p>`,btn;
  if(r.logged<10){h+=`<p style="margin:6px 0">這 3 週只有 ${r.logged} 天有記錄飲食，資料不夠完整，建議先每天都記錄，再判斷要不要調整。</p>`;btn='<button class="alt sm" id="tipno">知道了，2 週後再提醒</button>'}
  else if(r.tg.floored||r.tg.kcal-100<r.tg.floorK){h+='<p style="margin:6px 0">每天熱量已接近基礎代謝，不建議再減少飲食。可以試著增加活動量，或和醫師、營養師討論。</p>';btn='<button class="alt sm" id="tipno">知道了，2 週後再提醒</button>'}
  else{h+='<p style="margin:6px 0">你有好好記錄，但體重沒有照預期下降。可以考慮把每天熱量再降 100 大卡，或增加活動量。</p>';btn='<button class="sm" id="tipok">每天少吃 100 大卡</button><button class="alt sm" id="tipno">先不用，2 週後再提醒</button>'}
  el.innerHTML=h+`<div class="row">${btn}</div>`;el.hidden=false;
  const n=$('#tipno');if(n)n.onclick=()=>{db.p.snz=ymd(new Date(Date.now()+14*864e5));save();render()};
  const o=$('#tipok');if(o)o.onclick=()=>{db.p.kadj=Math.max(-300,(db.p.kadj||0)-100);db.p.kadjAt=today();save();render();toast('已調整每天熱量目標')};
}
function renderAct(){
  const s=actSug(),el=$('#actsug'),cur=String(db.p.act||'1.375'),L={'1.2':'久坐','1.375':'輕度','1.55':'中度','1.725':'高度'};
  el.innerHTML=!s?'累積 14 天以上的步數資料後，會依你的平均步數建議活動量。':s.lv===cur?`最近 4 週平均每天約 ${s.avg} 步，和你選的「${L[cur]}」相符。`
    :`最近 4 週平均每天約 <b>${s.avg} 步</b>，建議選「<b>${L[s.lv]}</b>」（目前是「${L[cur]}」）。<div style="margin-top:6px"><button class="alt sm" id="actok">改成${L[s.lv]}</button></div>`;
  if(s)el.innerHTML+='<div class="mut" style="font-size:12px;margin-top:4px">步數只是粗略參考，不包含重量訓練等運動。</div>';
  const b=$('#actok');if(b)b.onclick=()=>{$('#act').value=s.lv;saveProfile();toast(`已改成「${L[s.lv]}」`)};
}
(()=>{const y=new Date().getFullYear(),o=(v,t)=>`<option value="${v}">${t}</option>`;
  $('#by').innerHTML=o('','年')+Array.from({length:y-1929},(_,i)=>o(y-i,y-i)).join('');
  $('#bm').innerHTML=o('','月')+Array.from({length:12},(_,i)=>o(i+1,(i+1)+' 月')).join('');
  $('#bd').innerHTML=o('','日')+Array.from({length:31},(_,i)=>o(i+1,(i+1)+' 日')).join('');
  $('#kreset').onclick=()=>{db.p.kadj=0;db.p.kadjAt='';save();render();toast('已取消微調')};
})();
const isSnack=m=>m.snack!==undefined?m.snack===true:(m.type==='snack'&&m.typeManual!==0);
const hasSnack=d=>(d?.meals||[]).some(isSnack);
const IC=(n,sz=22)=>{const D={spark:'<path d="M12 4l1.8 4.6L18 10l-4.2 1.4L12 16l-1.8-4.6L6 10l4.2-1.4z"/><path d="M18 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',bowl:'<path d="M4 12h16a8 8 0 0 1-16 0z"/><path d="M9 8c0-1.6 1.2-1.6 1.2-3.2M14 8c0-1.6 1.2-1.6 1.2-3.2"/>',plus:'<path d="M12 5v14M5 12h14"/>',refresh:'<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>'};return`<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${D[n]||''}</svg>`};
const EXL={rest:'休息',light:'輕度',mod:'中度',high:'高強度'},PALD={rest:1.2,light:1.375,mod:1.55,high:1.725},EXH={rest:'幾乎沒活動',light:'散步、瑜珈、伸展',mod:'慢跑、騎車、游泳',high:'重訓、長跑、球賽、HIIT'};
const dateStr=()=>{const d=new Date();return`${d.getMonth()+1}月${d.getDate()}日 週${'日一二三四五六'[d.getDay()]}`};

// ======================= 「今天」分頁 =======================
function mealRow(k,m){
  const a=m.ai,b=busy.has(m),nm=a?.name||(b?'AI 辨識中…':'未分析'),kc=a?.kcal;
  const macro=a?[a.protein_g!=null?`蛋白質 ${a.protein_g}g`:'',a.carb_g!=null?`碳水 ${a.carb_g}g`:'',a.fat_g!=null?`脂肪 ${a.fat_g}g`:''].filter(Boolean).join('　'):(b?'通常 5～20 秒':'點一下編輯');
  return`<button class="mrow${b?' busy':''}" data-mo="${k}|${m.id}">${m.imgId?`<img data-img="${m.imgId}" alt="">`:`<span class="mimg">${IC('bowl',26)}</span>`}<span class="mmain"><b>${esc(nm)}</b><span class="mut">${m.t}${m.rid?'<i class="tag g">固定</i>':''}${isSnack(m)?'<i class="tag">點心</i>':''}${m.q?'<i class="tag">待確認</i>':''}　${esc(macro)}</span></span><span class="mk"><b>${kc!=null?kc:'-'}</b><span>大卡</span></span></button>`;
}
function dayCard(k){
  const d=db.days[k]||{meals:[]},rv=rvFind('day',k);
  return`<div class="card"><div class="rowh" style="margin-bottom:10px"><b style="font-size:17px">${k}</b><button class="alt sm" data-addk="${k}">${IC('plus',16)} 新增紀錄</button></div><div class="chips" style="grid-template-columns:repeat(4,1fr);margin-bottom:8px">${[['體重',d.weight??'-'],['步數',d.steps??'-'],['消耗',d.kcalOut!=null?(d.kcalEst?'≈':'')+d.kcalOut:'-'],['攝取',kin(d)||'-']].map(([a,b])=>`<div class="chip" style="padding:10px;box-shadow:none;background:var(--tint)"><span>${a}</span><b style="font-size:15px">${b}</b></div>`).join('')}</div>`
   +`<div style="margin:4px 0 10px">${exSeg(k,d.ex||'')}</div>`
   +`${hxHtml(d)}${nutLine(d)}`
   +(d.meals.length?`<div class="grp" style="box-shadow:none;border:1px solid var(--ln);margin-top:8px">${d.meals.map(m=>mealRow(k,m)).join('')}</div>`:'<p class="mut">當天沒有餐點紀錄</p>')
   +tagPills(k,d)+(rv?`<p class="mut" style="margin:12px 0 4px">AI 今日總結</p><div class="md">${mdHtml(rv.text)}</div><button class="alt sm" style="margin-top:6px" data-regenk="${k}">${IC('refresh',16)} 重新產生</button>`:(k<=today()?`<button class="alt sm" style="margin-top:10px" data-regenk="${k}">${IC('refresh',16)} 產生今日總結</button>`:''))+'</div>';
}
function renderHero(){
  const k=today(),tg=targets(k),{t,miss}=nutSum([day(k)]),el=$('#hero');let h;
  if(!tg||!tg.kcal)h='<div class="hero-empty"><b>先設定每日目標</b><span>填寫身高、生日與活動量，這裡就會顯示今天還能吃多少。</span><button class="sm" data-gonut="1">前往設定</button></div>';
  else{
    const eaten=Math.round(t.kcal),left=tg.kcal-eaten,over=left<0,R=56,C=2*Math.PI*R,pct=Math.min(1,eaten/tg.kcal),da=`${(C*pct).toFixed(1)} ${C.toFixed(1)}`;
    const mini=[['p','蛋白質'],['c','碳水'],['f','脂肪'],['fib','纖維']].map(([f,l])=>{const v=Math.round(t[f]),g=tg[f],o=g&&(f==='c'||f==='f')&&v>g*1.05;return`<div class="mg"><span>${l}</span><b>${v}${g?`<small style="opacity:.7;font-weight:500"> /${g}</small>`:''}</b><div class="mb"><i class="${o?'ov':''}" ${aw('mb'+f,g?v/g*100:0)}></i></div></div>`}).join('');
    h=`<div class="hero-top"><div class="ringw"><svg viewBox="0 0 150 150" width="150" height="150" role="img" aria-label="今日熱量進度"><circle class="rt" cx="75" cy="75" r="${R}"/><circle class="rp${over?' ov':''}" stroke-opacity="${eaten>0?1:0}" cx="75" cy="75" r="${R}" data-ak="ring" data-ad="${da}" style="stroke-dasharray:${animLast.ring||'0 '+C.toFixed(1)}" transform="rotate(-90 75 75)"/></svg><div class="ringc"><span>${over?'已超過':'還可以吃'}</span><b>${Math.abs(left)}</b><span>大卡</span></div></div>`
     +`<div class="hero-side"><div class="hs"><span>已吃</span><b>${eaten}</b></div><div class="hs"><span>今日目標</span><b>${tg.kcal}</b></div>${tg.ex?`<span class="badge">運動${EXL[tg.ex]} ${tg.exDelta>=0?'+':''}${tg.exDelta}</span>`:''}</div></div>`
     +`<div class="mgrid">${mini}</div>${miss.c||miss.f?'<div class="hero-note">有餐點缺碳水或脂肪資料，數字可能偏低</div>':''}`;
  }
  el.innerHTML=h;animate(el);
}
// 運動強度（單選）與標記（多選）：「今天」頁和歷史的每一天共用同一種外觀
const EXO=[['','平常'],['rest','休息'],['light','輕度'],['mod','中度'],['high','高強度']];
const CHK='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
function exSeg(k,cur){return`<div class="exseg" role="radiogroup" aria-label="運動強度">${EXO.map(([v,l])=>`<button type="button" role="radio" aria-checked="${cur===v}" class="${cur===v?'on':''}" data-ex="${v}" data-exk="${k}">${l}</button>`).join('')}</div>`}
function tagChips(k,d,withAdd){const L=db.tags||[],cur=new Set(d.tags||[]);return`<div class="tchips">${L.map(t=>{const on=cur.has(t.id);return`<button type="button" class="tchip${on?' on':''}" style="--c:${tagC(t.id)}" aria-pressed="${on}" data-tgk="${k}" data-tg="${t.id}"><span class="tdot">${on?CHK:''}</span>${esc(t.name)}</button>`}).join('')}${withAdd?`<button type="button" class="tchip add" data-tgadd="1">＋ ${L.length?'新增':'新增標記'}</button>`:''}</div>`}
function renderEx(){
  const k=today(),cur=day(k).ex||'',tg=targets(k);
  $('#exseg').innerHTML=exSeg(k,cur);
  $('#exd').innerHTML=cur&&tg&&tg.exDelta?`<span class="exd">目標 ${tg.exDelta>=0?'+':''}${tg.exDelta} 大卡</span>`:'';
  $('#exhint').textContent=cur?EXH[cur]:'依今天實際活動選，目標熱量會跟著調整';
}
function renderTagRow(){
  const L=db.tags||[];
  $('#tagrow').innerHTML=tagChips(today(),day(today()),true)+(L.length?'':'<p class="mut" style="margin:8px 2px 0;font-size:13px">例如「重訓」「聚餐」「生理期」，新增後點一下就能標在今天。</p>');
  $('#tgmg').hidden=!L.length;
}
function goTagMgr(){showTab('set');const t=$('#tagmgr').closest('details');t.open=true;setTimeout(()=>{t.scrollIntoView({behavior:'smooth',block:'start'});$('#tgnew')?.focus()},60)}
$('#tgmg').onclick=goTagMgr;
document.addEventListener('click',e=>{if(e.target.closest('[data-tgadd]'))goTagMgr()});
function renderToday(){
  const d=day(today()),ks=Object.keys(db.days).sort(),wk=ks.filter(k=>db.days[k].weight).at(-1),lw=wk?db.days[wk].weight:db.p.w0,fk=ks.filter(k=>db.days[k].h?.fat!=null).at(-1),lf=fk?db.days[fk].h.fat:null;
  // 體重、體脂不一定每天量：顯示最近一次，不是今天量的就在下面標日期
  const ago=k=>k&&k!==today()?`<small class="mut" style="display:block;font-size:11px;font-weight:500">${+k.slice(5,7)}/${+k.slice(8)}</small>`:'';
  $('#chips').style.gridTemplateColumns='repeat(4,1fr)';
  $('#chips').innerHTML=[['體重 kg',lw!=null?lw:'-',ago(wk)],['體脂 %',lf!=null?lf:'-',ago(fk)],['步數',d.steps!=null?d.steps.toLocaleString():'-',''],['消耗 大卡',d.kcalOut!=null?(d.kcalEst?'≈':'')+d.kcalOut.toLocaleString():'-','']].map(([a,b,c])=>`<div class="chip"><span>${a}</span><b>${b}</b>${c}</div>`).join('');
  renderQs();
  $('#meals').innerHTML=d.meals.length?`<div class="grp">${d.meals.map(m=>mealRow(today(),m)).join('')}</div>`:`<div class="empty">${IC('bowl',34)}<b>今天還沒有紀錄</b><span class="mut">點右下角的 ＋，拍下第一餐</span></div>`;
  {const nw=db.rvh.at(-1),fresh=nw?.pk!==renderToday.np,rv=['day','week','month'].map(k=>latestRv(k)).filter(Boolean),el=$('#reviews'),op=new Set([...el.querySelectorAll('details[open]')].map(x=>x.dataset.k));renderToday.np=nw?.pk;
  // 剛產生新總結時自動展開它；其他時候保留使用者自己展開／收合的狀態
  el.innerHTML=rv.map(r=>`<details class="card" data-k="${r.kind}" ${(fresh?r.kind===nw.kind:op.has(r.kind))?'open':''}><summary><span class="si">${IC('spark',20)}</span><span style="display:grid;line-height:1.25"><b>${KN[r.kind]}</b><span class="mut" style="font-weight:400">${r.date}</span></span></summary><div class="md">${mdHtml(r.text)}</div></details>`).join('');}
  {const p=hxItems(d).filter(([a])=>a!=='體脂');$('#hxd').innerHTML=p.length?`<div class="hx">${p.map(([a,b])=>`<span>${esc(a)} <b>${esc(b)}</b></span>`).join('')}</div>`:'<p class="mut">今天還沒有睡眠、心率等數據，同步後會顯示在這裡</p>'}
  renderHero();renderTagRow();renderEx();renderRtn();renderTip();
}
document.addEventListener('click',e=>{
  const ak=e.target.closest('[data-addk]');if(ak){openAddFor(ak.dataset.addk);return}
  const rk=e.target.closest('[data-regenk]');if(rk){regenDay(rk.dataset.regenk);return}
  const b=e.target.closest('[data-ex]');if(b){const k=b.dataset.exk||today(),v=b.dataset.ex,d=day(k);if(v)d.ex=v;else delete d.ex;save();render();return}
  const m=e.target.closest('[data-mo]');if(m){const[k,id]=m.dataset.mo.split('|');openMealSheet(k,id)}
});

// ======================= AI 金鑰：自動記住 =======================
const KEYSTORE='dietcoach_keys';
function keysSave(){try{localStorage.setItem(KEYSTORE,JSON.stringify({gkey:db.p.gkey||'',key:db.p.key||'',gmodel:db.p.gmodel||'',prov:db.p.prov||''}))}catch(e){}}
(()=>{try{const kv=JSON.parse(localStorage.getItem(KEYSTORE)||'{}');['gkey','key','gmodel','prov'].forEach(f=>{if(kv[f]!==undefined)db.p[f]=kv[f]})}catch(e){}})();
function aiUi(){
  const pv=db.p.prov||'gemini',k=pv==='gemini'?db.p.gkey:db.p.key;
  document.querySelectorAll('#provseg button').forEach(b=>b.classList.toggle('on',b.dataset.pv===pv));
  $('#gbox').hidden=pv!=='gemini';$('#cbox').hidden=pv!=='claude';
  $('#aist').textContent=k?`已儲存　••••${k.slice(-4)}`:'尚未設定金鑰';$('#aidot').classList.toggle('on',!!k);
}
var keyT=null;
function keyAuto(){clearTimeout(keyT);keyT=setTimeout(()=>{db.p.gkey=$('#gkey').value.trim();db.p.key=$('#key').value.trim();db.p.gmodel=$('#gmodel').value.trim();db.p.prov=$('#prov').value;keysSave();save();aiUi()},300)}
['gkey','key','gmodel'].forEach(i=>$('#'+i).addEventListener('input',keyAuto));
$('#provseg').onclick=e=>{const b=e.target.closest('button');if(!b)return;$('#prov').value=b.dataset.pv;db.p.prov=b.dataset.pv;keysSave();save();aiUi()};
$('#aitest').onclick=async()=>{clearTimeout(keyT);db.p.gkey=$('#gkey').value.trim();db.p.key=$('#key').value.trim();db.p.gmodel=$('#gmodel').value.trim();db.p.prov=$('#prov').value;keysSave();save();aiUi();toast('測試中…');try{await ai('只回覆 OK','你是連線測試',20);toast('連線成功，金鑰有效')}catch(e){toast('連線失敗：'+e.message)}};
$('#aiclr').onclick=async()=>{if(!await ask('清除金鑰？','清除目前這個 AI 服務的金鑰，之後要重新貼上。','清除',true))return;if((db.p.prov||'gemini')==='gemini'){db.p.gkey='';$('#gkey').value=''}else{db.p.key='';$('#key').value=''}keysSave();save();aiUi();toast('已清除')};
function mdHtml(t){
  const inl=x=>esc(x).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*\*/g,'');
  let out='',list=false;const close=()=>{if(list){out+='</ul>';list=false}};
  for(const raw of String(t||'').replace(/\r/g,'').split('\n')){
    const l=raw.replace(/\s+$/,'');if(!l.trim()){close();continue}
    let m;
    if(m=l.match(/^\s*#{1,4}\s+(.*)$/)){close();out+=`<h4 class="mdh">${inl(m[1].replace(/^\*\*|\*\*$/g,''))}</h4>`;continue}
    if(/^\s*([-*_])\1{2,}\s*$/.test(l)){close();out+='<hr>';continue}
    if(m=l.match(/^(\s*)[*\-•]\s+(.*)$/)){if(!list){out+='<ul>';list=true}out+=`<li class="${m[1].length>=2?'nest':''}">${inl(m[2])}</li>`;continue}
    if(m=l.match(/^\s*(\d+)[.)、]\s+(.*)$/)){close();out+=`<div class="mdn"><b>${m[1]}</b><span>${inl(m[2])}</span></div>`;continue}
    close();out+=`<p>${inl(l.trim())}</p>`;
  }
  close();return out;
}
const plain=t=>String(t||'').replace(/[#*>`_]/g,'').replace(/\s+/g,' ').trim();
var lastY=0;addEventListener('scroll',()=>{const y=scrollY,f=$('#fab');if(!f)return;if(y>lastY+8&&y>120)f.classList.add('hide');else if(y<lastY-8)f.classList.remove('hide');lastY=y},{passive:true});

// ======================= 消耗熱量來源 =======================
function restKcal(){const p=db.p;if(+p.rest>0)return Math.round(+p.rest);const w=curWeight(),h=p.ht,a=ageNow();return w&&h&&a?Math.round(10*w+6.25*h-5*a+(p.sx==='m'?5:-161)):0}
function restFor(k){const r=restKcal();if(!r)return 0;if(k!==today())return r;return Math.round(r*Math.max(0,Math.min(1,(Date.now()-new Date(k+'T00:00').getTime())/864e5)))}
function candKcal(d,k){const c={...(d.kcalSrc||{})};if(d.kcalAct!=null&&!d.kcalBas){const r=restFor(k);if(r)c['活動＋估算基礎代謝']=d.kcalAct+r}return c}
function applyKcal(k,d){const c=candKcal(d,k),pr=db.p.ksrc;let n=null;if(pr&&c[pr]!=null)n=pr;else{let mx=-1;for(const[a,v]of Object.entries(c))if(v>mx){mx=v;n=a}}if(n!=null){d.kcalOut=c[n];d.kcalEst=n==='活動＋估算基礎代謝'}return c}
function recalcKcal(){const seen={};Object.entries(db.days).forEach(([k,d])=>{if(d.kcalSrc){Object.keys(applyKcal(k,d)).forEach(a=>seen[a]=(seen[a]||0)+1)}});return seen}
const WKN={walking:'走路',running:'跑步',cycling:'騎單車',biking:'騎單車',swimming:'游泳',hiking:'健行',yoga:'瑜珈',strength_training:'重訓',weightlifting:'重訓',elliptical:'橢圓機',rowing:'划船',dancing:'跳舞',stair_climbing:'爬樓梯',hiit:'HIIT',pilates:'皮拉提斯',other_workout:'其他運動'},wkName=n=>WKN[String(n).toLowerCase()]||n;
function ksrcUi(){
  const el=$('#ksrc');if(!el||document.activeElement===el)return;const seen=db.kSrcSeen||{},cur=db.p.ksrc||'';el.innerHTML='';
  const add=(v,t)=>{const o=document.createElement('option');o.value=v;o.textContent=t;el.appendChild(o)};
  add('','自動（取最高）');Object.entries(seen).forEach(([a,n])=>add(a,`${a}（${n} 天）`));if(cur&&!seen[cur])add(cur,cur);el.value=cur;
  const r=$('#rest');if(r&&document.activeElement!==r){r.value=db.p.rest||'';r.placeholder=`留空＝公式估算 ${restKcal()}`}
}
$('#ksrc').onchange=()=>{db.p.ksrc=$('#ksrc').value;recalcKcal();save();render()};
$('#rest').onchange=()=>{db.p.rest=Math.max(0,+$('#rest').value||0);recalcKcal();save();render()};

// ======================= 固定餐 =======================
const RTS={breakfast:['早餐','08:00'],lunch:['午餐','12:00'],dinner:['晚餐','18:30'],snack:['點心','15:30']},WDN='日一二三四五六';
const hmin=t=>{const[a,b]=String(t||'0:0').split(':');return(+a)*60+(+b||0)};
const rtDays=r=>r.days&&r.days.length<7?r.days.map(d=>'週'+WDN[d]).join('、'):'每天';
function rtMeal(r){const a=r.ai||{},m={id:newId('m'),t:r.t,rid:r.id,ai:{name:r.name,kcal:a.kcal,protein_g:a.protein_g,carb_g:a.carb_g,fat_g:a.fat_g,fiber_g:a.fiber_g,note:'固定餐'}};if(r.desc)m.desc=r.desc;if(r.slot==='snack')m.snack=true;if(r.items&&r.items.length)m.items=r.items.map(x=>({...x}));return m}
function addRoutine(id,k=today(),manual=true){
  const r=(db.routines||[]).find(x=>x.id===id);if(!r)return false;const d=day(k);
  if(d.meals.some(m=>m.rid===id)){if(manual)toast('這天已經加過了');return false}
  if(d.skip){d.skip=d.skip.filter(x=>x!==id);if(!d.skip.length)delete d.skip}
  d.meals.push(rtMeal(r));d.meals.sort(byT);return true}
function applyRoutines(){
  const L=(db.routines||[]).filter(r=>r.auto);if(!L.length)return;const now=new Date(),tk=today();let n=0;
  for(let i=0;i<3;i++){const k=addD(tk,-i),wd=new Date(k+'T00:00').getDay();
    for(const r of L){
      if(k<(r.since||'')||(r.days&&!r.days.includes(wd)))continue;
      if(i===0&&now<new Date(k+'T'+r.t+':00'))continue;
      const d=db.days[k];
      if(d){if(d.meals.some(m=>m.rid===r.id)||(d.skip||[]).includes(r.id))continue;if(d.meals.some(m=>!m.rid&&Math.abs(hmin(m.t)-hmin(r.t))<=90))continue}
      if(addRoutine(r.id,k,false))n++}}
  if(n){save();render();toast(`已自動加入 ${n} 筆固定餐`)}
}
function renderRtn(){
  const el=$('#rtn');if(!el)return;const d=db.days[today()]||{meals:[]},wd=new Date().getDay();
  const L=(db.routines||[]).filter(r=>!(r.days&&!r.days.includes(wd))&&!d.meals.some(m=>m.rid===r.id));
  if(!L.length){el.hidden=true;return}
  el.hidden=false;el.innerHTML=`<div class="exh"><b>快速加入固定餐</b><button class="alt sm" id="rtmg">管理</button></div><div class="pills">${L.map(r=>`<button class="pill" data-rta="${r.id}">＋ ${esc((RTS[r.slot]||[''])[0])} ${esc(r.name)}</button>`).join('')}</div>`;
  $('#rtmg').onclick=()=>{showTab('food');setFt('rt')};
}
function renderRtList(){
  const el=$('#rtlist');if(!el)return;const L=db.routines||[];
  el.innerHTML=L.length?L.map(r=>`<button class="li" style="grid-template-columns:1fr auto" data-rt="${r.id}"><span><b>${esc(r.name)}</b><br><span class="mut">${esc((RTS[r.slot]||[''])[0])} ${esc(r.t)}　${rtDays(r)}${r.auto?'　自動加入':''}</span></span><span style="text-align:right"><b style="font-size:17px">${r.ai&&r.ai.kcal!=null?r.ai.kcal:'-'}</b><br><span class="mut">大卡</span></span></button>`).join(''):'<div class="empty"><b>還沒有固定餐</b><span class="mut">在餐點編輯頁按「設為固定餐」，或按下面新增</span></div>';
}
function setFt(v){document.querySelectorAll('#fseg button').forEach(b=>b.classList.toggle('on',b.dataset.ft===v));$('#foodcard').hidden=v!=='food';$('#rtcard').hidden=v!=='rt'}
$('#fseg').onclick=e=>{const b=e.target.closest('button');if(b)setFt(b.dataset.ft)};setFt('food');
var rt={id:null,slot:'breakfast',days:new Set([0,1,2,3,4,5,6]),items:[]};
function openRt(src){
  const r=src||{};rt={id:r.id||null,slot:r.slot||'breakfast',days:new Set(r.days&&r.days.length?r.days:[0,1,2,3,4,5,6]),items:(r.items||[]).map(x=>({...x}))};
  const a=r.ai||{},f=v=>v==null?'':v;delete $('#rt-t').dataset.touched;
  $('#rtt').textContent=r.id?'編輯固定餐':'新增固定餐';$('#rt-n').value=r.name||'';$('#rt-t').value=r.t||RTS[rt.slot][1];$('#rt-d').value=r.desc||'';$('#rt-auto').checked=r.id?!!r.auto:true;
  [['k','kcal'],['p','protein_g'],['c','carb_g'],['f','fat_g'],['b','fiber_g']].forEach(([x,y])=>$('#rt-'+x).value=f(a[y]));
  $('#rt-del').hidden=!r.id;renderRt();libReset(rLib);openSheet($('#rtd'));
}
function renderRt(){
  document.querySelectorAll('#rt-slot button').forEach(b=>b.classList.toggle('on',b.dataset.sl===rt.slot));
  document.querySelectorAll('#rt-days button').forEach(b=>b.classList.toggle('on',rt.days.has(+b.dataset.wd)));
}
function rtFill(){
  if(!rt.items.length)return;
  const t=rt.items.reduce((a,i)=>({k:a.k+i.kcal*i.qty,p:a.p+(i.protein_g||0)*i.qty,c:a.c+(i.carb_g||0)*i.qty,f:a.f+(i.fat_g||0)*i.qty,b:a.b+(i.fiber_g||0)*i.qty}),{k:0,p:0,c:0,f:0,b:0});
  $('#rt-k').value=Math.round(t.k);$('#rt-p').value=Math.round(t.p);$('#rt-c').value=Math.round(t.c);$('#rt-f').value=Math.round(t.f);$('#rt-b').value=Math.round(t.b*10)/10;
  if(!$('#rt-n').value.trim())$('#rt-n').value=rt.items.map(i=>i.name).join('＋').slice(0,20);
}
$('#rtd').addEventListener('click',e=>{
  const sl=e.target.closest('[data-sl]');if(sl){rt.slot=sl.dataset.sl;if(!$('#rt-t').dataset.touched)$('#rt-t').value=RTS[rt.slot][1];renderRt();return}
  const wd=e.target.closest('[data-wd]');if(wd){const v=+wd.dataset.wd;if(rt.days.has(v))rt.days.delete(v);else rt.days.add(v);renderRt();return}
});
$('#rtd').addEventListener('input',e=>{if(e.target.id==='rt-t')e.target.dataset.touched='1'});
const rLib=libMount($('#rt-lib'),()=>rt.items,rtFill);
$('#rt-save').onclick=()=>{
  const name=$('#rt-n').value.trim();if(!name)return toast('請填名稱');
  const nv=id=>{const v=$('#'+id).value;return v===''?null:+v},k=nv('rt-k');if(k==null||!(k>=0))return toast('請填熱量');if(!rt.days.size)return toast('至少選一天');
  const old=rt.id&&(db.routines||[]).find(x=>x.id===rt.id);
  const r={id:rt.id||newId('rt'),name,slot:rt.slot,t:$('#rt-t').value||RTS[rt.slot][1],days:rt.days.size===7?null:[...rt.days].sort(),auto:$('#rt-auto').checked,desc:$('#rt-d').value.trim()||undefined,
    items:rt.items.map(({name,unit,qty,kcal,protein_g,carb_g,fat_g,fiber_g})=>({name,unit,qty,kcal,protein_g,carb_g,fat_g,fiber_g})),
    ai:{name,kcal:Math.round(k),protein_g:nv('rt-p'),carb_g:nv('rt-c'),fat_g:nv('rt-f'),fiber_g:nv('rt-b')},since:old?old.since:today()};
  if(!r.desc)delete r.desc;if(!r.items.length)delete r.items;
  db.routines=db.routines||[];const i=db.routines.findIndex(x=>x.id===r.id);if(i>=0)db.routines[i]=r;else db.routines.push(r);
  closeSheet($('#rtd'));save();applyRoutines();render();toast('已儲存固定餐');
};
$('#rt-del').onclick=()=>{
  const i=db.routines.findIndex(x=>x.id===rt.id);if(i<0)return;const r=db.routines[i];db.routines.splice(i,1);save();closeSheet($('#rtd'));render();
  toast(`已刪除固定餐「${r.name}」（已加入的餐點不受影響）`,{label:'復原',fn:()=>{db.routines.splice(Math.min(i,db.routines.length),0,r);save();render();toast('已復原')}});
};
$('#rt-x').onclick=()=>closeSheet($('#rtd'));$('#rtadd').onclick=()=>openRt();
$('#se-rt').onclick=()=>{const m=curMeal()?.m;if(!m)return;const a=m.ai||{},h=hmin(m.t),slot=isSnack(m)?'snack':h<630?'breakfast':h<930?'lunch':h<1260?'dinner':'snack';closeSheet($('#msd'));showTab('food');setFt('rt');openRt({name:a.name||'',slot,t:m.t,desc:m.desc,ai:a,items:m.items})};
document.addEventListener('click',e=>{
  const a=e.target.closest('[data-rta]');if(a){if(addRoutine(a.dataset.rta)){save();render();toast('已加入今天')}return}
  const b=e.target.closest('[data-rt]');if(b){const r=(db.routines||[]).find(x=>x.id===b.dataset.rt);if(r)openRt(r)}
});
setInterval(applyRoutines,60000);

// ======================= 標記 =======================
const TAGC=['#e4572e','#e0a92c','#2f8a5f','#2d8ab0','#5b5bd6','#b0479a','#8a6a4d','#6a7a71'];
function tagC(t){const d=db.tags||[],i=d.findIndex(x=>x.id===t);return i>=0?TAGC[d[i].c%TAGC.length]:'var(--mut)'}
function tagN(t){return(db.tags||[]).find(x=>x.id===t)?.name||t}
function toggleTag(k,id){const d=day(k);d.tags=d.tags||[];const i=d.tags.indexOf(id);if(i>=0)d.tags.splice(i,1);else d.tags.push(id);if(!d.tags.length)delete d.tags;save();render()}
function tagPills(k,d){return(db.tags||[]).length?`<h3 style="margin:14px 0 8px">標記</h3>${tagChips(k,d,false)}`:''}
document.addEventListener('click',e=>{const b=e.target.closest('[data-tg]');if(b)toggleTag(b.dataset.tgk,b.dataset.tg)});
function tagDots(d){if(!d||!d.tags||!d.tags.length)return'';const ids=d.tags.filter(t=>(db.tags||[]).some(x=>x.id===t));if(!ids.length)return'';
  return ids.slice(0,3).map(t=>`<i style="background:${tagC(t)}"></i>`).join('')+(ids.length>3?`<b class="tgmore">+${ids.length-3}</b>`:'')}
function renderTagMgr(){
  const el=$('#tagmgr');if(!el||document.activeElement?.id==='tgnew')return;const L=db.tags||[],typed=$('#tgnew')?.value||'';
  el.innerHTML=(L.length?L.map(t=>`<div class="row" style="align-items:center;margin:6px 0"><span style="width:16px;height:16px;border-radius:5px;background:${tagC(t.id)};flex:none"></span><span style="flex:1">${esc(t.name)}</span><button class="alt sm" data-tgdel="${t.id}">刪除</button></div>`).join(''):'<p class="mut" style="margin:4px 0">還沒有標記</p>')
    +'<div class="row" style="margin-top:8px"><input id="tgnew" placeholder="新增標記，例如：重訓" style="flex:1;margin:0"><button class="sm" id="tgadd">新增</button></div>';
  $('#tgnew').value=typed;
  $('#tgadd').onclick=()=>{const n=$('#tgnew').value.trim();if(!n)return;if((db.tags||[]).some(t=>t.name===n))return toast('已經有這個標記了');
    db.tags=db.tags||[];db.tags.push({id:newId('tg'),name:n,c:db.tags.length});$('#tgnew').value='';save();render();toast('已新增')};
  el.querySelectorAll('[data-tgdel]').forEach(b=>b.onclick=async()=>{const id=b.dataset.tgdel,n=Object.values(db.days).filter(d=>(d.tags||[]).includes(id)).length;
    if(!await ask(`刪除標記「${tagN(id)}」？`,n?`已經標記過的 ${n} 天會一併移除這個標記。`:'','刪除',true))return;
    db.tags=db.tags.filter(t=>t.id!==id);Object.values(db.days).forEach(d=>{if(d.tags){d.tags=d.tags.filter(t=>t!==id);if(!d.tags.length)delete d.tags}});save();render()});
}

// ======================= 分頁：只畫目前看得到的分頁，切換時有轉場 =======================
const TT={today:'今天',trend:'趨勢',hist:'歷史紀錄',food:'食物庫',set:'設定'},SUB={trend:'體重與熱量走勢',hist:'回顧每一天',food:'常吃的食物',set:'個人化與連線'};
const TABS=['today','trend','hist','food','set'],dirty=new Set(TABS),scrollMem={};let curTab='';
function render(){
  const d=day(today());if(d.kcalAct!=null&&!d.kcalBas)applyKcal(today(),d);
  TABS.forEach(t=>dirty.add(t));renderTab(curTab);
}
function renderTab(t){
  dirty.delete(t);
  if(t==='today')renderToday();else if(t==='trend'){drawCharts();renderNut7()}else if(t==='hist')renderHist();else if(t==='food'){renderFoods();renderRtList()}else if(t==='set')renderSet();
  loadImgs();
}
function showTab(t,fromNav){
  if(t===curTab){if(fromNav)scrollTo({top:0,behavior:RM.matches?'auto':'smooth'});else if(dirty.has(t))renderTab(t);return}
  const prev=curTab;scrollMem[prev]=scrollY;
  const apply=()=>{
    curTab=t;document.querySelectorAll('.tab').forEach(e=>e.hidden=e.id!=='t-'+t);
    document.querySelectorAll('#nav button').forEach(b=>{const on=b.dataset.tab===t;b.classList.toggle('on',on);b.setAttribute('aria-current',on?'page':'false')});
    $('#ttl').textContent=TT[t];$('#subttl').textContent=t==='today'?dateStr():SUB[t]||'';
    $('#fab').hidden=t!=='today';document.body.classList.toggle('fabon',t==='today');
    if(dirty.has(t))renderTab(t);
    scrollTo(0,fromNav?(scrollMem[t]||0):0);
  };
  if(fromNav&&document.startViewTransition&&!RM.matches){document.documentElement.style.setProperty('--vd',TABS.indexOf(t)>TABS.indexOf(prev)?1:-1);document.startViewTransition(apply)}
  else apply();
}
$('#nav').onclick=e=>{const b=e.target.closest('button');if(b)showTab(b.dataset.tab,true)};
$('#sync').onclick=()=>sync(+$('#sr').value);

// ======================= 趨勢圖 =======================
var wc=null,cc=null,wMore=false;
function wkStart(k){const d=new Date(k+'T00:00');d.setDate(d.getDate()-(d.getDay()+6)%7);return ymd(d)}
function linSlope(p){const mx=avg(p.map(q=>q[0])),my=avg(p.map(q=>q[1]));let a=0,b=0;p.forEach(q=>{a+=(q[0]-mx)*(q[1]-my);b+=(q[0]-mx)**2});return b?a/b:0}
const kfmt=v=>v>=1000?(Math.round(v/100)/10).toString()+'k':String(v);
function drawCharts(){
  document.querySelectorAll('#trs button').forEach(b=>b.classList.toggle('on',b.dataset.n==String(tr)));
  const md=k=>(+k.slice(5,7))+'/'+(+k.slice(8)),N=trN(),ks=[...Array(N)].map((_,i)=>ymd(new Date(Date.now()-(N-1-i)*864e5)));
  const all=Object.keys(db.days).filter(k=>db.days[k].weight).sort(),cur=all.length?db.days[all.at(-1)].weight:null,p0=db.p.w0||(all.length?db.days[all[0]].weight:null),wt=db.p.wt;
  // ===== 目標進度 =====
  let h='';
  if(cur!=null&&p0&&wt){
    const tot=p0-wt,done=p0-cur,pct=tot>0?Math.max(0,Math.min(100,done/tot*100)):0,msg=[];
    h=`<div class="bigrow"><div><span class="mut">目前體重</span><br><span class="pu"><b class="bn">${cur}</b> kg</span></div><div style="text-align:right"><span class="mut">${done>=0?'已經瘦了':'比起點重了'}</span><br><span class="pu"><b class="bn">${Math.abs(done).toFixed(1)}</b> kg</span></div></div>
    <div class="pbar" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i ${aw('prog',pct)}></i></div>
    <div class="bigrow"><span class="mut">起點 ${p0}</span><span class="mut">${tot>0?`完成 ${Math.round(pct)}%`:''}</span><span class="mut">目標 ${wt}</span></div>`;
    msg.push(cur>wt?`距離目標還差 <b>${(cur-wt).toFixed(1)} 公斤</b>。`:'<b>已經達到目標體重！</b>');
    const rec=all.filter(k=>k>=ymd(new Date(Date.now()-28*864e5)));
    if(cur>wt){
      if(rec.length>=5){const t0=new Date(rec[0]),sl=linSlope(rec.map(k=>[(new Date(k)-t0)/864e5,db.days[k].weight])),wr=-sl*7;
        if(sl<-0.005){msg.push(`最近 4 週平均每週瘦 ${wr.toFixed(2)} 公斤，照這個速度大約 <b>${ymd(new Date(Date.now()+(cur-wt)/-sl*864e5))}</b> 達標（粗估）。`)}
        else msg.push('最近 4 週體重沒有明顯下降。');
        if(db.p.dt&&db.p.dt>today()){const left=(new Date(db.p.dt)-Date.now())/864e5/7,need=(cur-wt)/Math.max(left,.5);
          msg.push(`要在 ${db.p.dt} 前達標，每週需要瘦約 ${need.toFixed(2)} 公斤；`+(wr>=need?'你目前的速度跟得上。':'你目前的速度稍慢，可參考 AI 檢討的建議。'))}
      }else msg.push('最近 4 週的體重紀錄還不夠，累積後會顯示預估達標日。');
    }
    h+=`<p style="margin:10px 0 0">${msg.join('<br>')}</p>`;
  }else h='<p class="mut" style="margin:0">到「設定」填入起始體重與目標體重，並同步體重資料後，這裡會顯示你的進度。</p>';
  $('#prog').innerHTML=h;animate($('#prog'));
  // ===== 體重走勢：每天實測（淡點）＋ 7 天平均（粗線）=====
  const W=340,H=170,L=34,R=14,T=14,B=24,pts=ks.map((k,i)=>[i,db.days[k]?.weight]).filter(p=>p[1]),el=$('#chart');
  if(pts.length<2){el.innerHTML='<text x="10" y="80" font-size="13" fill="var(--mut)">需要至少 2 筆體重資料才會畫出走勢</text>';$('#wsum').textContent='';wc=null}
  else{
    const ma=pts.map(p=>{const w=pts.filter(q=>q[0]<=p[0]&&q[0]>p[0]-7);return[p[0],avg(w.map(q=>q[1]))]}),a=ma[0],z=ma.at(-1),vs=ma.map(p=>p[1]).concat(pts.map(p=>p[1]),wt||[]);
    const mn=Math.min(...vs)-.3,mx_=Math.max(...vs)+.3,stp=(mx_-mn)<=4?1:(mx_-mn)<=10?2:(mx_-mn)<=20?5:10,lo=Math.floor(mn/stp)*stp,hi=Math.ceil(mx_/stp)*stp;
    const x=i=>L+i*(W-L-R)/Math.max(N-1,1),y=v=>H-B-(v-lo)/(hi-lo)*(H-B-T);
    let g=Array.from({length:Math.round((hi-lo)/stp)+1},(_,i)=>lo+i*stp).map(v=>`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--ln)"/><text x="${L-5}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--mut)">${Math.round(v)}</text>`).join('');
    if(wt)g+=`<line x1="${L}" x2="${W-R}" y1="${y(wt)}" y2="${y(wt)}" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${L+4}" y="${y(wt)-5}" font-size="12" fill="var(--warn)" font-weight="600">目標 ${wt}</text>`;
    const pr=N>120?1.6:2.4;g+=pts.map(p=>`<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="${pr}" fill="var(--ac)" opacity=".28"/>`).join('');
    g+=`<path d="${ma.map((p,j)=>(j?'L':'M')+x(p[0]).toFixed(1)+' '+y(p[1]).toFixed(1)).join('')}" fill="none" stroke="var(--ac)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`
      +`<circle cx="${x(a[0])}" cy="${y(a[1])}" r="4.5" fill="var(--ac)"/><text x="${x(a[0])+4}" y="${y(a[1])-9}" font-size="13" font-weight="700" fill="var(--ink)">${a[1].toFixed(1)}</text>`
      +`<circle cx="${x(z[0])}" cy="${y(z[1])}" r="4.5" fill="var(--ac)"/><text x="${x(z[0])-4}" y="${y(z[1])-9}" text-anchor="end" font-size="13" font-weight="700" fill="var(--ink)">${z[1].toFixed(1)}</text>`
      +[[0,'start'],[Math.floor((N-1)/2),'middle'],[N-1,'end']].map(([i,an])=>`<text x="${x(i)}" y="${H-6}" text-anchor="${an}" font-size="11" fill="var(--mut)">${md(ks[i])}</text>`).join('');
    el.innerHTML=g;wc={x,ks,N,L,R,W,pts};
    $('#wsum').innerHTML=`${md(ks[0])} → ${md(ks.at(-1))}：<b>${a[1].toFixed(1)} → ${z[1].toFixed(1)} kg</b>（${chg(z[1]-a[1])}）`;
  }
  $('#wrd').textContent='點圖看當天體重';
  // ===== 每週／每月平均 =====
  const mon=N>100,G={};
  all.filter(k=>k>=ks[0]).forEach(k=>{(G[mon?k.slice(0,7):wkStart(k)]??=[]).push(db.days[k].weight)});
  const rows=Object.entries(G).sort().map(([g,v])=>({g,a:avg(v)}));rows.forEach((r,i)=>r.d=i?r.a-rows[i-1].a:null);
  $('#plt').textContent=mon?'每月平均體重':'每週平均體重';
  if(rows.length){
    const mnv=Math.min(...rows.map(r=>r.a)),mxv=Math.max(...rows.map(r=>r.a)),show=(wMore?rows:rows.slice(-6)).slice().reverse();
    $('#wlist').innerHTML=show.map(r=>`<div class="wr"><span>${mon?r.g:md(r.g)+'–'+md(addD(r.g,6))}</span><span class="wb"><i ${aw('wb'+r.g,rows.length>1?30+70*(r.a-mnv)/Math.max(mxv-mnv,.1):100)}></i></span><b>${r.a.toFixed(1)}</b><span class="${r.d==null?'':r.d<=0?'dn':'up'}">${r.d==null?'':(r.d<=0?'▼ ':'▲ ')+Math.abs(r.d).toFixed(1)}</span></div>`).join('')
      +(rows.length>6?`<button class="alt sm" id="wmore" style="margin-top:8px">${wMore?'只看最近 6 筆':`顯示全部 ${rows.length} 筆`}</button>`:'');
    animate($('#wlist'));
    const b=$('#wmore');if(b)b.onclick=()=>{wMore=!wMore;drawCharts()};
  }else $('#wlist').innerHTML='<p class="mut">還沒有體重資料</p>';
  // ===== 每天吃進與消耗的差 =====
  const k2=[...Array(14)].map((_,i)=>ymd(new Date(Date.now()-(13-i)*864e5))),dd=k2.map(k=>db.days[k]||{}),ins=dd.map(d=>kin(d)),outs=dd.map(d=>d.kcalOut||0);
  const net=ins.map((v,i)=>v&&outs[i]?outs[i]-v:null),vals=net.filter(v=>v!=null);
  const H2=206,T2=32,B2=34,df=vals.some(v=>v<0)?1:.3,ph=H2-T2-B2,upH=ph/(1+df),dnH=ph-upH,y0=T2+upH,top=Math.max(500,Math.ceil(Math.max(0,...vals.map(Math.abs))/250)*250),bw=(W-L-R)/14;
  let c=`<line x1="${L}" x2="${W-R}" y1="${y0}" y2="${y0}" stroke="var(--ink)" stroke-width="1"/><text x="${L-5}" y="${y0+4}" text-anchor="end" font-size="11" fill="var(--mut)">0</text>`
   +`<text x="${L-5}" y="${T2+4}" text-anchor="end" font-size="11" fill="var(--mut)">${kfmt(top)}</text>${df===1?`<text x="${L-5}" y="${H2-B2+4}" text-anchor="end" font-size="11" fill="var(--mut)">-${kfmt(top)}</text>`:''}`
   +`<text x="${L}" y="13" font-size="12" fill="var(--ok)" font-weight="600">▲ 吃得比消耗少（有瘦的機會）</text><text x="${L}" y="${H2-B2+17}" font-size="12" fill="var(--warn)" font-weight="600">▼ 吃得比消耗多</text>`;
  k2.forEach((k,i)=>{const x0=L+i*bw+bw*.15,w=bw*.7,v=net[i];
    if(v==null)c+=`<circle cx="${x0+w/2}" cy="${y0}" r="2.5" fill="var(--mut)" opacity=".5"/>`;
    else{const hh=Math.max(1,Math.min(Math.abs(v)/top*upH,v>=0?upH:dnH));
      c+=`<rect x="${x0}" y="${v>=0?y0-hh:y0}" width="${w}" height="${hh}" rx="2" fill="${v>=0?'var(--ok)':'var(--warn)'}"/><text x="${x0+w/2}" y="${v>=0?y0-hh-3:y0+hh+11}" text-anchor="middle" font-size="${kfmt(Math.round(Math.abs(v))).length>3?8.5:10}" fill="var(--ink)">${kfmt(Math.round(Math.abs(v)))}</text>`}
    c+=`<text x="${x0+w/2}" y="${H2-6}" text-anchor="middle" font-size="10" fill="var(--mut)">${+k.slice(8)}</text>`});
  $('#cal').innerHTML=c;
  const both=vals.length;
  if(both){const m=avg(vals),ai_=avg(k2.map((k,i)=>net[i]!=null?ins[i]:null).filter(v=>v!=null)),ao=avg(k2.map((k,i)=>net[i]!=null?outs[i]:null).filter(v=>v!=null));
    $('#csum').innerHTML=`近 14 天有 ${both} 天有完整紀錄：平均每天吃 ${Math.round(ai_)}、消耗 ${Math.round(ao)} 大卡。<br><b>平均每天${m>=0?'少吃':'多吃'} ${Math.abs(Math.round(m))} 大卡</b>，粗估每週約${m>=0?'瘦':'胖'} ${(Math.abs(m)*7/7700).toFixed(2)} 公斤。`}
  else $('#csum').textContent='記錄飲食並同步消耗熱量後，這裡會顯示你每天吃進與消耗的差距。';
  cc={k2,ins,outs,L,R,W};$('#crd').textContent='點圖看當天熱量';
}
$('#chart').onclick=e=>{if(!wc)return;const r=e.currentTarget.getBoundingClientRect(),vx=(e.clientX-r.left)/r.width*wc.W,i=Math.round((vx-wc.L)/(wc.W-wc.L-wc.R)*(wc.N-1));
  const p=wc.pts.reduce((m,q)=>Math.abs(q[0]-i)<Math.abs(m[0]-i)?q:m);$('#wrd').textContent=`${wc.ks[p[0]]}　量到的體重 ${p[1]} kg`};
$('#cal').onclick=e=>{if(!cc)return;const r=e.currentTarget.getBoundingClientRect(),vx=(e.clientX-r.left)/r.width*cc.W,i=Math.max(0,Math.min(13,Math.floor((vx-cc.L)/((cc.W-cc.L-cc.R)/14))));
  const a=cc.ins[i],o=cc.outs[i];$('#crd').textContent=a&&o?`${cc.k2[i]}　吃 ${a}、消耗 ${o} 大卡 → ${o>=a?'少吃':'多吃'} ${Math.abs(o-a)} 大卡`:`${cc.k2[i]}　缺少${a?'':'飲食'}${!a&&!o?'與':''}${o?'':'消耗'}紀錄`};

// ======================= 提醒（設定改了自動套用） =======================
var remT=null;function remindSoon(){clearTimeout(remT);remT=setTimeout(remind,800)}
async function remind(){
  const L=window.Capacitor?.Plugins?.LocalNotifications;bgPush();if(!L)return;
  try{
    let r=await L.checkPermissions();if(r.display!=='granted')r=await L.requestPermissions();
    if(r.display!=='granted')return toast('沒有通知權限，提醒不會出現（可到手機設定開啟）');
    try{Promise.resolve(BRP()?.requestPermissions({apis:['notifications']})).catch(()=>{})}catch(e){}
    const m=db.p.rm||readRm(),hm=t=>{const[hour,minute]=String(t||'20:00').split(':').map(Number);return{hour,minute}};
    const n=(id,title,body,on)=>({id,title,body,schedule:{on,allowWhileIdle:true}}),list=[];
    if(m.rd)list.push(n(1,'今日總結時間','稍後會自動產生今日總結，也可以打開 App 查看',hm(m.rdt)));
    if(m.rw)list.push(n(2,'本週檢討時間','稍後會自動產生本週檢討，也可以打開 App 查看',{weekday:+m.rwd,...hm(m.rwt)}));
    if(m.rm)list.push(n(3,'本月檢討時間','稍後會自動產生本月檢討，也記得匯出備份',{day:+m.rmd,...hm(m.rmt)}));
    await L.cancel({notifications:[{id:1},{id:2},{id:3}]}).catch(()=>{});
    if(list.length)await L.schedule({notifications:list});
    toast(list.length?'提醒時間已更新':'已關閉所有提醒');
  }catch(e){toast('設定提醒失敗：'+e.message)}
}
window.Capacitor?.Plugins?.LocalNotifications?.addListener('localNotificationActionPerformed',e=>{showTab('today');autoCheck()});

// ======================= 背景執行（App 沒開時產生總結） =======================
const BR_LABEL='com.dietcoach.app.background';
function BRP(){return window.Capacitor?.Plugins?.BackgroundRunner}
const isNative=()=>!!(window.Capacitor?.isNativePlatform?.()||window.Capacitor?.getPlatform?.()==='android');
var bgTimer=null,bgPulling=null,bgMeta=null;
const donePks=()=>db.rvh.map(r=>r.pk||(r.kind+':'+r.date));
function bgState(){
  const rm=db.p.rm||{},p=db.p,days={},prev={};
  for(let i=0;i<100;i++){const k=addD(today(),-i),d=db.days[k];if(has(d))days[k]=dline(k)}
  ['day','week','month'].forEach(k=>{const r=latestRv(k);if(r)prev[k]=r.text});
  return{enabled:rm.aut!==false&&rm.bgr!==false,prov:p.prov||'gemini',gkey:p.gkey||'',ckey:p.key||'',model:p.gmodel||'',tz:new Date().getTimezoneOffset(),
    rm:{rd:rm.rd,rdt:rm.rdt,rw:rm.rw,rwd:rm.rwd,rwt:rm.rwt,rm:rm.rm,rmd:rm.rmd,rmt:rm.rmt},head:summaryHead(),instr:INSTR,sys:SYS,prev,days,
    done:db.rvh.filter(r=>r.date>=addD(today(),-100)).map(r=>r.pk)};
}
function bgPush(){const B=BRP();if(!B)return;clearTimeout(bgTimer);try{Promise.resolve(B.dispatchEvent({label:BR_LABEL,event:'sync',details:{state:bgState()}})).catch(()=>{})}catch(e){}}
function bgSoon(){if(!BRP())return;clearTimeout(bgTimer);bgTimer=setTimeout(bgPush,4000)}
function bgPull(){
  const B=BRP();if(!B)return Promise.resolve();
  bgPulling=(async()=>{
    try{
      const r=await B.dispatchEvent({label:BR_LABEL,event:'pull',details:{}}),list=r?.pending||[],ack=[];
      list.forEach(x=>{if(!rvFind(x.kind,x.date))db.rvh.push({kind:x.kind,date:x.date,text:x.text,pk:x.pk,auto:true,bg:true});ack.push(x.pk)});
      if(list.length){save();render();toast(`背景已產生 ${list.length} 份 AI 總結`);await B.dispatchEvent({label:BR_LABEL,event:'pull',details:{ack}})}
      bgMeta=r?.meta||{};
    }catch(e){bgMeta={err:String((e&&e.message)||e)}}
    bgStatus();
  })();return bgPulling;
}
function bgStatus(){
  const el=$('#bgst');if(!el)return;const row=$('#bgr').closest('label');
  if(!BRP()){
    row.hidden=isNative();
    el.textContent=isNative()?'這個版本沒有背景執行功能（打包時背景外掛失敗，自動改用不含背景執行的版本）。打開 App 時仍會自動補產生錯過的總結。':'背景狀態：只有安裝在手機上的 App 才能使用。';return}
  row.hidden=false;const m=bgMeta||{};
  el.textContent='背景狀態：'+(m.err?`讀取失敗（${m.err}）`:m.lastRun?`系統上次叫醒 ${new Date(m.lastRun).toLocaleString()}，當次產生 ${m.lastCount||0} 份${m.lastErr?`；上次錯誤：${m.lastErr}`:''}`:'尚未執行過（App 退到背景後，要等系統叫醒，約 15 分鐘以上才會有紀錄）');
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)bgPush();else bgPull().then(bgPush)});
if(BRP()){setTimeout(()=>bgPull().then(bgPush),700);if(!db.bgAsked){db.bgAsked=1;try{Promise.resolve(BRP().requestPermissions({apis:['notifications']})).catch(()=>{})}catch(e){}}}

// ======================= 打開 App 時補產生錯過的總結（和背景用同一份 DCJobs.planJobs） =======================
var autoBusy=false,autoFailAt=0;
async function autoCheck(){
  if(bgPulling)await bgPulling;
  const rm=db.p.rm||{};if(!window.DCJobs||autoBusy||rm.aut===false||Date.now()-autoFailAt<30*60e3)return;
  const days={};for(let i=0;i<100;i++){const k=addD(today(),-i);if(has(db.days[k]))days[k]=true}
  const now=new Date(),jobs=DCJobs.planJobs({rm,days},ymd(now)+'T'+now.toTimeString().slice(0,5),donePks());
  if(!jobs.length)return;
  autoBusy=true;
  try{
    if(window.Capacitor?.Plugins?.Health&&db.lastSync&&Date.now()-db.lastSync>3*3600e3)await sync(3,true);
    for(const[kind,end]of jobs.slice(0,8)){if(!await review(kind,end,true)){autoFailAt=Date.now();break}}
  }finally{autoBusy=false}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)autoCheck()});
setInterval(()=>{if(!document.hidden)autoCheck()},60000);setTimeout(autoCheck,2500);

// ======================= Android 返回鍵 =======================
// 有視窗開著 → 關視窗；不在「今天」→ 回「今天」；都沒有 → 把 App 退到背景（不是直接結束）
{const AppP=window.Capacitor?.Plugins?.App;
 if(AppP)try{AppP.addListener('backButton',()=>{const d=topSheet();if(d){dismissSheet(d);return}if(curTab!=='today'){showTab('today',true);return}Promise.resolve().then(()=>AppP.minimizeApp()).catch(()=>AppP.exitApp())})}catch(e){}}

// ======================= 第一次使用的設定引導 =======================
let ob=0;
const OBN=3;
function obSel(id,opts,val){return`<select id="${id}">${opts.map(([v,t])=>`<option value="${v}"${String(v)===String(val)?' selected':''}>${t}</option>`).join('')}</select>`}
function obRender(){
  const p=db.p;$('#obdots').innerHTML=[...Array(OBN)].map((_,i)=>`<i class="${i===ob?'on':''}"></i>`).join('');
  $('#obnext').textContent=ob===OBN-1?'完成':'下一步';$('#obskip').textContent=ob===0?'略過':'上一步';
  const c=$('#obc');
  if(ob===0){const pv=p.prov||'gemini';
    c.innerHTML=`<div class="sh-t">歡迎使用減重教練</div><p class="mut" style="margin-top:0">花一分鐘完成 3 個設定。<br><b style="color:var(--ink)">第 1 步：AI 連線</b>（辨識餐點照片、產生每日總結）</p>
    <div class="seg" id="obpv" style="margin-bottom:10px"><button data-pv="gemini" class="${pv==='gemini'?'on':''}">Gemini（免費額度）</button><button data-pv="claude" class="${pv==='claude'?'on':''}">Claude</button></div>
    <label><span id="obkl">${pv==='gemini'?'Gemini':'Claude'} API Key</span><input id="obkey" type="password" autocomplete="off" placeholder="貼上金鑰，之後可在設定修改" value="${esc(pv==='gemini'?p.gkey||'':p.key||'')}"></label>
    <p class="mut" style="margin:0">Gemini 金鑰可到 aistudio.google.com 免費申請。金鑰只存在這支手機上。</p>`;
    $('#obpv').onclick=e=>{const b=e.target.closest('button');if(!b)return;obSave();db.p.prov=b.dataset.pv;obRender()};
  }else if(ob===1){const[b1]=(p.bd||'').split('-');
    c.innerHTML=`<div class="sh-t">第 2 步：基本資料</div><p class="mut" style="margin-top:0">用來計算每天該吃多少熱量與營養素。</p>
    <div class="tm"><label>目前體重 (kg)<input id="obw0" type="number" step="0.1" inputmode="decimal" value="${p.w0??''}"></label><label>目標體重 (kg)<input id="obwt" type="number" step="0.1" inputmode="decimal" value="${p.wt??''}"></label></div>
    <div class="tm"><label>身高 (cm)<input id="obht" type="number" inputmode="decimal" value="${p.ht??''}"></label><label>性別${obSel('obsx',[['f','女'],['m','男']],p.sx||'f')}</label></div>
    <label>生日<input id="obbd" type="date" max="${today()}" value="${b1?p.bd:''}"></label>
    <label>平常活動量${obSel('obact',[['1.2','久坐（幾乎不運動）'],['1.375','輕度（每週運動 1–3 天）'],['1.55','中度（每週運動 3–5 天）'],['1.725','高度（每週運動 6–7 天）']],p.act||'1.375')}</label>`;
  }else{
    const tg=targets();
    c.innerHTML=`<div class="sh-t">第 3 步：連接 Health Connect</div><p class="mut" style="margin-top:0">自動讀取步數、體重、消耗熱量、睡眠、心率等數據，不用手動輸入。系統會跳出授權畫面，請允許需要的項目。</p>
    ${tg&&tg.kcal?`<div class="callout">依你的資料，每天建議吃 <b>${tg.kcal} 大卡</b>，蛋白質 ${tg.p}g。之後可在「設定 → 每日營養目標」調整。</div>`:''}
    <button class="alt" id="obhc" style="width:100%;margin-top:6px">${db.lastSync?'已連接，再同步一次':'連接並同步'}</button>
    <p class="mut" style="margin:8px 0 0">${isNative()?'也可以之後再按右上角的同步按鈕。':'這一步只能在手機 App 裡做，可以先略過。'}</p>`;
    $('#obhc').onclick=async()=>{await sync(30);obRender()};
  }
}
function obSave(){
  const p=db.p,v=id=>$('#'+id)?.value;
  if(ob===0&&$('#obkey')){const k=v('obkey').trim();if((p.prov||'gemini')==='gemini')p.gkey=k;else p.key=k;keysSave()}
  if(ob===1&&$('#obw0')){const nn=id=>v(id)===''?null:+v(id);Object.assign(p,{w0:nn('obw0'),wt:nn('obwt'),ht:nn('obht'),sx:v('obsx'),act:v('obact')});if(v('obbd'))p.bd=v('obbd')}
  save();
}
function obFinish(){obSave();db.obDone=1;save();closeSheet($('#obd'));render();toast('設定完成！點右下角的 ＋ 記錄第一餐')}
function openOb(){ob=0;obRender();openSheet($('#obd'))}
$('#obnext').onclick=()=>{obSave();if(ob<OBN-1){ob++;obRender()}else obFinish()};
$('#obskip').onclick=()=>{obSave();if(ob>0){ob--;obRender()}else{db.obDone=1;save();closeSheet($('#obd'));render()}};
$('#obd')._onDismiss=()=>{obSave();db.obDone=1;save();render()};
$('#obagain').onclick=openOb;

// ======================= 啟動 =======================
render();showTab('today');
if(upgraded)save();
normalizeDb();finishMigrate();applyRoutines();
if(window.Capacitor?.Plugins?.Health&&db.lastSync)sync(30,true);
if(!db.obDone&&!db.p.gkey&&!db.p.key&&!targets())setTimeout(openOb,400);
window.__appReady=true;
