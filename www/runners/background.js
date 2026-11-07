// 背景執行檔：由系統每 15 分鐘以上叫醒一次（不保證準時）。
// 這裡讀不到網頁的資料，所以 App 會把需要的資料「推」進來（sync 事件），
// 這裡把到期、還沒產生的 AI 總結做出來，放進 pending，並發通知；App 打開時再「拉」回去（pull 事件）。
//
// 這個檔案同時也被 App 本身載入（index.html 的開機程式），App 用的是同一份 DCJobs.planJobs / buildPrompt，
// 這樣「哪些總結該產生」「提示詞長怎樣」只有一份程式碼，不會兩邊改不一致。
// 在 App 裡面（有 document）時，下面的背景事件不會註冊。

var DCJobs = (function () {
  function pad(n) { return n < 10 ? '0' + n : '' + n }
  function ymd(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) }
  function addD(k, n) { var p = k.split('-'); return ymd(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n))) }
  function dow(k) { var p = k.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() }
  var LABEL = { day: '今日總結', week: '本週檢討', month: '本月檢討' }, N = { day: 1, week: 7, month: 30 }, PREV = { day: '每日', week: '每週', month: '每月' };

  // st.rm：提醒設定；st.days：有資料的日期 → 該日摘要字串（或 true）；nowStr：當地時間 'YYYY-MM-DDTHH:MM'；done：已產生的 'kind:date'
  function planJobs(st, nowStr, done) {
    var rm = st.rm || {}, jobs = [], today = nowStr.slice(0, 10), i, k;
    function has(kind, d) { return done.indexOf(kind + ':' + d) >= 0 }
    function hasData(end, n) { for (var j = 0; j < n; j++)if (st.days[addD(end, -j)]) return true; return false }
    function due(d, t) { return nowStr >= d + 'T' + (t || '21:00') }
    if (rm.rd !== false) for (i = 0; i < 3; i++) { k = addD(today, -i); if (due(k, rm.rdt) && !has('day', k) && hasData(k, 1)) jobs.push(['day', k]) }
    if (rm.rw !== false) { var wd = (+(rm.rwd || 1)) - 1, c = 0; for (i = 0; i < 14 && c < 2; i++) { k = addD(today, -i); if (dow(k) === wd && due(k, rm.rwt || '20:00') && !has('week', k) && hasData(k, 7)) { jobs.push(['week', k]); c++ } } }
    if (rm.rm !== false) {
      var md = +(rm.rmd || 1), y = +today.slice(0, 4), m = +today.slice(5, 7);
      for (var mo = 0; mo < 2; mo++) { var mm = m - mo, yy = y; if (mm < 1) { mm += 12; yy -= 1 } k = yy + '-' + pad(mm) + '-' + pad(md); if (k <= today && due(k, rm.rmt || '20:00') && !has('month', k) && hasData(k, 30)) jobs.push(['month', k]) }
    }
    jobs.sort(function (a, b) { return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : (a[0] < b[0] ? -1 : 1) });
    return jobs;
  }
  // st.head：使用者資料與目標；st.days：日期 → 該日摘要；st.prev[kind]：上一次同類建議；st.instr[kind]：回答格式
  function buildPrompt(st, kind, end) {
    var n = N[kind], lines = [], i, k, prev = st.prev && st.prev[kind];
    for (i = n - 1; i >= 0; i--) { k = addD(end, -i); lines.push(typeof st.days[k] === 'string' ? st.days[k] : (k + '｜無紀錄')) }
    return st.head + '\n\n（以 ' + end + ' 為「今天」）最近' + n + '天紀錄：\n' + lines.join('\n') + '\n\n'
      + (prev ? '上一次的' + PREV[kind] + '建議：\n' + prev + '\n\n請先檢視上次的建議有沒有做到、成效如何。\n' : '') + st.instr[kind];
  }
  return { planJobs: planJobs, buildPrompt: buildPrompt, addD: addD, LABEL: LABEL };
})();

(function () {
  if (typeof document !== 'undefined') return; // 在 App 畫面裡只拿 DCJobs，不註冊背景事件
  function kvGet(k, def) { try { var r = CapacitorKV.get(k); return r && r.value ? JSON.parse(r.value) : def } catch (e) { return def } }
  function kvSet(k, v) { CapacitorKV.set(k, JSON.stringify(v)) }
  function errMsg(status, j) {
    var m = (j && j.error && j.error.message) || '';
    if (status === 429) return '使用次數超過限制（免費額度可能用完）';
    if (status === 401 || status === 403 || /API key/i.test(m)) return '金鑰無效或沒有權限';
    if (status >= 500) return 'AI 服務暫時忙碌';
    return m || ('API 錯誤 ' + status);
  }
  function callAI(st, prompt) {
    if (st.prov === 'claude') {
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': st.ckey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1500, system: st.sys, messages: [{ role: 'user', content: prompt }] })
      }).then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { if (!r.ok || j.error) throw new Error(errMsg(r.status, j)); return (j.content || []).map(function (c) { return c.text || '' }).join('') }) });
    }
    return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(st.model || 'gemini-3.8-flash') + ':generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': st.gkey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: st.sys }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 6000 } })
    }).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) {
        if (!r.ok || j.error) throw new Error(errMsg(r.status, j));
        var t = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).filter(function (x) { return !x.thought }).map(function (x) { return x.text || '' }).join('');
        if (!t) throw new Error('AI 沒有回覆內容'); return t;
      });
    });
  }
  function run() {
    var meta = kvGet('meta', {}); meta.lastRun = Date.now(); meta.lastCount = 0; kvSet('meta', meta);
    var st = kvGet('state', null);
    if (!st || !st.enabled || !(st.prov === 'claude' ? st.ckey : st.gkey)) return Promise.resolve();
    var nowStr = new Date(Date.now() - (st.tz || 0) * 60000).toISOString().slice(0, 16);
    var pend = kvGet('pending', []), done = (st.done || []).concat(pend.map(function (x) { return x.pk }));
    var jobs = DCJobs.planJobs(st, nowStr, done).slice(0, 3), idx = 0;
    function next() {
      if (idx >= jobs.length) return Promise.resolve();
      var kind = jobs[idx][0], end = jobs[idx][1]; idx++;
      return callAI(st, DCJobs.buildPrompt(st, kind, end)).then(function (text) {
        pend = kvGet('pending', []); pend.push({ kind: kind, date: end, text: text, pk: kind + ':' + end }); kvSet('pending', pend);
        meta = kvGet('meta', {}); meta.lastCount = (meta.lastCount || 0) + 1; meta.lastErr = ''; kvSet('meta', meta);
        try { CapacitorNotifications.schedule([{ id: 200 + idx, title: 'AI 總結已產生', body: DCJobs.LABEL[kind] + '（' + end + '）已經整理好了，打開 App 查看', scheduleAt: new Date(Date.now() + 1000) }]) } catch (e) { }
        return next();
      });
    }
    return next();
  }
  addEventListener('sync', function (resolve, reject, args) {
    try { kvSet('state', args.state); resolve({ ok: true }) } catch (e) { resolve({ ok: false, err: String(e) }) }
  });
  addEventListener('pull', function (resolve, reject, args) {
    try {
      var pend = kvGet('pending', []);
      if (args && args.ack && args.ack.length) { pend = pend.filter(function (x) { return args.ack.indexOf(x.pk) < 0 }); kvSet('pending', pend); resolve({ pending: [], meta: kvGet('meta', {}) }); return }
      resolve({ pending: pend, meta: kvGet('meta', {}) });
    } catch (e) { resolve({ pending: [], meta: {}, err: String(e) }) }
  });
  addEventListener('checkSummaries', function (resolve, reject, args) {
    run().then(function () { resolve() }, function (e) { var m = kvGet('meta', {}); m.lastErr = String((e && e.message) || e); m.lastErrAt = Date.now(); kvSet('meta', m); resolve() });
  });
})();
