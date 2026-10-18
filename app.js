/* ============================================================
   独享库 · 前端脚本
   ============================================================ */
(function () {
  'use strict';

  var S = {
    sites: [],
    site: null,          // 兜底用的源 key（正常流程里每张卡都自带源）
    type: '',            // 当前分类
    page: 1,
    feedCats: [],        // 各源合并后的统一分类树（两级）
    feedSites: [],       // 参与合并的源
    cands: {},           // 片名 → 各源线路（详情页 / 播放器「播放源」用）
    catTop: '',          // 分类页：当前一级分类（= 规范化分类名）
    catType: '',         // 分类页：当前二级分类（空 = 该一级的全部）
    catPage: 1,
    detail: null,
    hls: null,
    curEp: null,
    curGroup: 0,
    favs: [],
    favKeys: {},
    cur: 'home',         // 当前所在主栏目（用于详情返回）
    idxTimer: null,
    idxWasRunning: false, // 用于识别「索引刚刚建完」从而刷新分类
    skip: null,           // 当前剧的片头/片尾 {intro,outro}
    seek: 0,              // 起播后要跳到的秒数（续播用）
    durKnown: 0,          // hls 播放列表里读到的总时长
    search: { wd: '', groups: [], view: 'merge' },  // 搜索结果 + 当前视图
    tried: {},            // 本次播放已经试过的源（自动换源用，避免死循环）
    swapBusy: false,      // 正在自动换源
    playReal: '',         // 当前这一集的上游真实地址（下载用）
    playSrc: '',          // 当前这一集的本地代理地址（播放 / 投屏用）
    mgrFav: false, mgrHis: false,   // 收藏/历史是否处于管理模式
    selFav: {}, selHis: {}          // 管理模式下勾选的条目
  };

  // 自动跳过片头片尾的开关（默认开）
  var AUTO = { on: true };
  try { AUTO.on = localStorage.getItem('dxk.autoskip') !== '0'; } catch (e) {}

  // 观看进度：{ "site:id": {gi,ei,pos,dur,intro,outro,time,...} }
  var P = { map: {}, lastPush: 0 };

  var TABS = ['home', 'cats', 'fav', 'history', 'mine'];

  /* ------------------------------------------------ 工具 */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var mm = (h ? (m < 10 ? '0' + m : m) : m) + ':' + (x < 10 ? '0' + x : x);
    return (h ? h + ':' : '') + mm;
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }

  /* 后端地址
     · 电脑版：就是本机，同源，SERVER 为空
     · 手机 / 平板 App：手机上没有 Python，所有接口都指向电脑的局域网地址
     地址存在 localStorage，首次打开 App 会让用户填一次。 */
  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform
                  && window.Capacitor.isNativePlatform());
  var SERVER = '';
  try { SERVER = (localStorage.getItem('dxk.server') || '').replace(/\/+$/, ''); } catch (e) {}

  // 把「/api/xxx」这类站内地址补成能跨机访问的完整地址
  function abs(u) {
    if (!u) return '';
    if (/^(https?:|blob:|data:)/i.test(u)) return u;
    return SERVER + (u.charAt(0) === '/' ? u : '/' + u);
  }

  function setServer(v) {
    SERVER = (v || '').trim().replace(/\/+$/, '');
    if (SERVER && !/^https?:/i.test(SERVER)) SERVER = 'http://' + SERVER;
    try {
      if (SERVER) localStorage.setItem('dxk.server', SERVER);
      else localStorage.removeItem('dxk.server');
    } catch (e) {}
  }

  /* 公网版：前端被托管在网页空间（如 Cloudflare Pages），没有电脑后端。
     采集源接口一律不发跨域头，浏览器直接取会被拦，所以请求统一交给一个很小的
     接口代理（见 公网版/worker.js）。这个开关只在 公网版/proxy.js 里注入，
     电脑版、安卓原生根本不会加载它 → 完全不受影响。 */
  var PUBLIC = !!window.DXK_CMS_PROXY;

  // 公网版：把地址换成走接口代理；电脑版 / 安卓原生（自带原生 HTTP，不受跨域限制）原样返回
  function proxyUrl(u) {
    if (!u || !PUBLIC || NATIVE) return u;
    return String(window.DXK_CMS_PROXY).replace(/\/+$/, '') + '/?url=' + encodeURIComponent(u);
  }

  // 手机 App 且没连电脑：直接走本机实现（local.js），自己直连影视源
  function isLocal() { return !!(window.DXK_LOCAL && !SERVER && (NATIVE || PUBLIC)); }

  function api(path, params, post) {
    if (isLocal()) return window.DXK_LOCAL.handle(path, params, post);
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    var opt = post
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) }
      : {};
    return fetch(SERVER + '/api' + path + qs, opt).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: '连接不到电脑上的独享库：' + e.message }; });
  }

  function imgUrl(u) {
    if (!u) return '';
    // 手机端独立运行：没有服务端图片代理，直接用原图地址
    // （公网版要走接口代理，源站图片大多有防盗链，直连会 403）
    if (isLocal()) return proxyUrl(u);
    return abs('/img?url=' + encodeURIComponent(u));
  }
  function picStyle(u) {
    if (!u) return '';
    // 手机端是直连原图地址，URL 直接拼进 style 属性；把引号和尖括号去掉，
    // 免得异常地址把属性撑破（合法图片地址里不会出现这些字符）。
    var s = imgUrl(u).replace(/'/g, '%27').replace(/["<>]/g, '');
    return "background-image:url('" + s + "')";
  }
  // 海报元素统一带 data-pic（原始地址），渲染后由 posterFill 换成缓存图
  function picAttr(u) {
    return ' style="' + picStyle(u) + '"' + (u ? ' data-pic="' + esc(u) + '"' : '');
  }

  /* ------------------------------------------------ 本地缓存

     片单/分类/海报存本机（IndexedDB + Cache Storage），进页面先把缓存画出来
     （秒开），再后台联网刷新；联网失败就保留缓存并提示「离线内容」。
     缓存只是加速层：拿不到就照常走网络。 */
  var CACHE = window.DXKCache || null;

  var offTimer = 0;
  function offlineBar(msg) {
    var el = $('offlineBar');
    if (!el) return;
    if (!msg) {
      clearTimeout(offTimer);
      offTimer = setTimeout(function () { el.classList.remove('show'); }, 2500);
      return;
    }
    clearTimeout(offTimer);
    el.textContent = msg;
    el.classList.add('show');
  }

  function agoText(ms) {
    var m = Math.floor((ms || 0) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  /* 先渲染缓存，再联网刷新。onData(r, meta) 会被调用 1~2 次：
     meta.cached = true 表示这一次是缓存（可能过期），false 表示刚联网拿到的。
     缓存读取很快，先读缓存再发请求，保证「秒开」且不会出现缓存太晚回来盖掉网络结果。 */
  function feedSWR(params, onData) {
    var pre = CACHE ? CACHE.feedGet(params).catch(function () { return null; })
                    : Promise.resolve(null);
    return pre.then(function (c) {
      if (c && c.data) {
        if (c.age > CACHE.feedFresh) offlineBar('离线内容 · 更新于 ' + agoText(c.age));
        onData(c.data, { cached: true, age: c.age });
      }
      return api('/feed', params);
    }).then(function (r) {
      if (r && r.ok) {
        offlineBar('');
        if (CACHE) CACHE.feedPut(params, r);
        onData(r, { cached: false });
      } else {
        offlineBar('网络异常，正在显示已缓存的内容');
        onData({ ok: false, error: (r && r.error) || '加载失败' }, { cached: false });
      }
    }).catch(function () {
      offlineBar('网络异常，正在显示已缓存的内容');
      onData({ ok: false, error: '加载失败' }, { cached: false });
    });
  }

  /* 海报：命中本地缓存就用本地图；没命中就照常显示网络图，并顺手存一份。
     离线时已缓存的封面仍能出来，没缓存的留占位。 */
  function applyPoster(el) {
    var raw = el.getAttribute && el.getAttribute('data-pic');
    if (!raw || el.dataset.dxkPic || !CACHE) return;
    el.dataset.dxkPic = '1';
    var key = imgUrl(raw);
    CACHE.imgGet(key).then(function (b) {
      if (b) { el.style.backgroundImage = "url('" + b.replace(/'/g, '%27') + "')"; return; }
      if (isLocal()) {
        // 手机端直连影视源，图片有防盗链，得用原生 HTTP 取
        nativeImgBlob(raw, function (bu) {
          if (!bu) return;
          el.style.backgroundImage = "url('" + bu.replace(/'/g, '%27') + "')";
          fetch(bu).then(function (r) { return r.blob(); })
            .then(function (bl) { CACHE.imgPut(key, bl); }).catch(function () {});
        });
        return;
      }
      fetch(key).then(function (r) { return r.ok ? r.blob() : null; }).then(function (bl) {
        if (!bl) return;
        el.style.backgroundImage = "url('" + URL.createObjectURL(bl).replace(/'/g, '%27') + "')";
        CACHE.imgPut(key, bl);
      }).catch(function () {});
    }).catch(function () {});
  }

  function posterFill(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-pic]').forEach(applyPoster);
  }

  /* 后台预热海报：断网时这些封面已经在本机了 */
  function preheatPosters(list) {
    if (!CACHE || isLocal() || !list || !list.length) return;
    var urls = [];
    list.forEach(function (v) { if (v && v.pic) urls.push(imgUrl(v.pic)); });
    if (urls.length) CACHE.imgPreheat(urls, 24);
  }

  /* 图片防盗链兜底：手机端独立模式下，<img> 加载失败时用原生 HTTP 取回图片
     转成 blob 地址再赋回去（只重试一次，避免死循环）。 */
  function nativeImgBlob(url, cb) {
    var cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (!cap || !cap.get || !url) { cb(''); return; }
    cap.get({
      url: url, responseType: 'blob', headers: { 'Referer': url },
      connectTimeout: 15000, readTimeout: 15000
    }).then(function (res) {
      var d = res && res.data;
      if (!d || typeof d === 'string') { cb(''); return; }
      try { cb(URL.createObjectURL(d)); } catch (e) { cb(''); }
    }).catch(function () { cb(''); });
  }

  function installImgFallback() {
    if (!isLocal()) return;
    document.addEventListener('error', function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'IMG') return;
      if (el.dataset.dxkRetry) return;
      el.dataset.dxkRetry = '1';
      nativeImgBlob(el.src, function (blobUrl) { if (blobUrl) el.src = blobUrl; });
    }, true);
  }

  /* ------------------------------------------------ 云同步（登录）

     数据分两处存：
       · 本机 sources.json —— 离线也能用（不登录时一切照旧）
       · 云端 Supabase   —— 登录后自动把「收藏 / 自定义影视源」同步上去
     电脑关机不影响手机、平板：它们各自直连云端的同一份数据。 */

  var CFG = window.DXK_CONFIG || {};
  var T_FAV = (CFG.tables && CFG.tables.favorites) || 'favorites';
  var T_SRC = (CFG.tables && CFG.tables.sources) || 'sources';
  var T_PROG = (CFG.tables && CFG.tables.progress) || 'progress';

  function cloudReady() {
    return !!(window.Cloud && window.Cloud.enabled() && window.Cloud.isLoggedIn());
  }

  function nowIso() { return new Date().toISOString(); }

  // 云端读写统一带上自己的账号 ID：即便云端的权限没配好
  // （比如忘了开行级安全），也不会读到 / 改到别人的记录
  function cloudMine(path) {
    var uid = window.Cloud.uid();
    if (!uid) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'user_id=eq.' + encodeURIComponent(uid);
  }

  function cloudFavUpsert(v) {
    var uid = window.Cloud.uid();
    if (!uid || !v || !v.key) return Promise.resolve();
    return window.Cloud.rest(T_FAV, {
      method: 'POST', prefer: 'resolution=merge-duplicates',
      body: { user_id: uid, key: v.key, site: v.site || '', id: v.id || '',
              name: v.name || '', pic: v.pic || '', updated_at: nowIso() }
    });
  }
  function cloudFavDelete(key) {
    return window.Cloud.rest(cloudMine(T_FAV + '?key=eq.' + encodeURIComponent(key)), { method: 'DELETE' });
  }
  function cloudSrcUpsert(s) {
    var uid = window.Cloud.uid();
    if (!uid || !s || !s.id) return Promise.resolve();
    return window.Cloud.rest(T_SRC, {
      method: 'POST', prefer: 'resolution=merge-duplicates',
      body: { user_id: uid, id: s.id, name: s.name || '', url: s.url || '',
              enabled: s.enabled !== false, updated_at: nowIso() }
    });
  }
  function cloudSrcDelete(id) {
    return window.Cloud.rest(cloudMine(T_SRC + '?id=eq.' + encodeURIComponent(id)), { method: 'DELETE' });
  }

  /* ---- 观看进度：云端读写 ---- */

  function cloudProgUpsert(r) {
    var uid = window.Cloud.uid();
    if (!uid || !r || !r.key) return Promise.resolve();
    return window.Cloud.rest(T_PROG, {
      method: 'POST', prefer: 'resolution=merge-duplicates',
      body: { user_id: uid, key: r.key, site: r.site || '', id: r.id || '',
              name: r.name || '', pic: r.pic || '',
              gi: r.gi || 0, ei: r.ei || 0, ep_name: r.epName || '',
              pos: r.pos || 0, dur: r.dur || 0,
              intro: r.intro || 0, outro: r.outro || 0,
              updated_at: nowIso() }
    });
  }

  function cloudProgGet(key) {
    if (!cloudReady()) return Promise.resolve(null);
    return window.Cloud.rest(cloudMine(T_PROG + '?select=*&key=eq.' + encodeURIComponent(key)))
      .then(function (rows) { return (rows && rows[0]) || null; })
      .catch(function () { return null; });
  }

  // 云端一行 → 本机一条进度
  function progFromCloud(c) {
    return {
      key: c.key, site: c.site || '', id: c.id || '',
      name: c.name || '', pic: c.pic || '',
      gi: c.gi || 0, ei: c.ei || 0, epName: c.ep_name || '',
      pos: c.pos || 0, dur: c.dur || 0,
      intro: c.intro || 0, outro: c.outro || 0,
      time: Date.parse(c.updated_at) || 0
    };
  }

  function progSaveLocal(rec) {
    P.map[rec.key] = rec;
    return api('/progress', null, rec);
  }

  // 登录后把云端进度和本机进度按「谁新用谁」合并
  function syncProgress() {
    return Promise.all([
      window.Cloud.rest(cloudMine(T_PROG + '?select=*&limit=500')),
      api('/state')
    ]).then(function (res) {
      var cloud = res[0] || [];
      var local = (res[1] && res[1].progress) || {};
      var cmap = {};
      cloud.forEach(function (c) { cmap[c.key] = c; });

      var chain = Promise.resolve();
      cloud.forEach(function (c) {
        var l = local[c.key];
        var cr = progFromCloud(c);
        if (!l || cr.time > (l.time || 0)) {
          P.map[c.key] = cr;
          chain = chain.then(function () { return progSaveLocal(cr); });
        }
      });
      Object.keys(local).forEach(function (k) {
        var c = cmap[k];
        if (!c || (local[k].time || 0) > (Date.parse(c.updated_at) || 0)) {
          chain = chain.then(function () { return cloudProgUpsert(local[k]); });
        }
      });
      return chain;
    }).catch(function () {});
  }

  // 登录后：云端 + 本机双向合并（各取并集，缺的补齐）
  function syncAll() {
    if (!cloudReady()) return Promise.resolve();
    return syncFavorites().then(syncSources).then(syncProgress);
  }

  function syncFavorites() {
    return Promise.all([
      window.Cloud.rest(cloudMine(T_FAV + '?select=*&order=updated_at.desc')),
      api('/state')
    ]).then(function (res) {
      var cloud = res[0] || [];
      var local = (res[1] && res[1].favorites) || [];
      var lk = {}, ck = {};
      local.forEach(function (f) { lk[f.key] = 1; });
      cloud.forEach(function (f) { ck[f.key] = 1; });

      var toLocal = cloud.filter(function (f) { return f.key && !lk[f.key]; });
      var toCloud = local.filter(function (f) { return f.key && !ck[f.key]; });

      var chain = Promise.resolve();
      toLocal.forEach(function (f) {
        chain = chain.then(function () {
          return api('/favorite', null, {
            video: { key: f.key, site: f.site, id: f.id, name: f.name, pic: f.pic }
          });
        });
      });
      toCloud.forEach(function (f) {
        chain = chain.then(function () { return cloudFavUpsert(f); });
      });
      return chain.then(function () { return loadFavs(); });
    }).catch(function (e) {
      toast('收藏同步失败：' + e.message, 3600);
    });
  }

  function syncSources() {
    return Promise.all([
      window.Cloud.rest(cloudMine(T_SRC + '?select=*')),
      api('/state')
    ]).then(function (res) {
      var cloud = res[0] || [];
      var local = ((res[1] && res[1].sources) || []).filter(function (s) { return !s.builtin; });
      var lk = {}, ck = {};
      local.forEach(function (s) { lk[s.id] = 1; });
      cloud.forEach(function (s) { ck[s.id] = 1; });

      var chain = Promise.resolve();
      cloud.forEach(function (s) {
        if (!s.id || lk[s.id] || !s.url) return;
        chain = chain.then(function () {
          return api('/source/add', null, { url: s.url, name: s.name || '' });
        });
      });
      local.forEach(function (s) {
        if (ck[s.id]) return;
        chain = chain.then(function () { return cloudSrcUpsert(s); });
      });
      return chain.then(function () {
        if ($('modal').classList.contains('show')) loadSrcState();
        loadSites();
      });
    }).catch(function (e) {
      toast('影视源同步失败：' + e.message, 3600);
    });
  }

  /* ---------------- 登录界面 ---------------- */

  function updateUserBtn() {
    var b = $('btnUser');
    var ready = !!(window.Cloud && window.Cloud.enabled());
    var em = (ready && window.Cloud.email()) || '';
    var nick = em ? em.split('@')[0] : '';
    var label = nick || (ready ? '登录' : '登录');
    if (b) {
      var n = $('userName'); if (n) n.textContent = label;
      var a = $('userAva');
      if (a) a.textContent = nick ? nick.slice(0, 1).toUpperCase() : '独';
      b.classList.toggle('on', !!nick);
      b.title = nick ? ('已登录：' + em) : '账号 / 登录';
    }
    var mn = $('mcName'), ma = $('mcAva'), ms = $('mcSub'), mb = $('mcLogin');
    if (ma) ma.textContent = nick ? nick.slice(0, 1).toUpperCase() : '独';
    if (mn) mn.textContent = nick || '未登录';
    if (ms) {
      ms.textContent = nick
        ? ('当前账号：' + em + '　收藏 / 自定义影视源 / 观看进度会同步到云端')
        : '登录后才能使用收藏、观看历史；登录后还会把影视源、观看进度同步到云端。';
    }
    if (mb) mb.textContent = nick ? '退出登录' : '登录 / 注册';
    applyAuthGate();
  }

  /* 未登录：不显示「收藏 / 观看历史」入口，首页也不显示「继续观看」。
     这些是账号级功能，未登录时既不展示、也不在本机留存。
     登录状态一变（登录 / 退出 / 启动）都会重新调用这里。 */
  function applyAuthGate() {
    var on = cloudReady();
    document.querySelectorAll('[data-nav="fav"], [data-nav="history"]').forEach(function (el) {
      el.style.display = on ? '' : 'none';
    });
    if (on) return;
    var hr = $('homeResume');
    if (hr) hr.innerHTML = '';
    if (S.cur === 'fav' || S.cur === 'history') go('home');
  }

  function openAuth() {
    $('authModal').classList.add('show');
    renderAuth();
  }
  function closeAuth() { $('authModal').classList.remove('show'); }

  function renderAuth() {
    var enabled = !!(window.Cloud && window.Cloud.enabled());
    var logged = cloudReady();
    var msg = $('authMsg');
    msg.className = 'msg'; msg.textContent = '';

    $('authTitle').textContent = logged ? '账号' : '登录独享库';
    $('authEmail').parentNode.style.display = logged ? 'none' : '';
    $('authPw').parentNode.style.display = logged ? 'none' : '';
    $('btnDoLogin').style.display = logged ? 'none' : '';
    $('btnDoSignup').style.display = logged ? 'none' : '';
    $('btnDoLogout').style.display = logged ? '' : 'none';

    if (!enabled) {
      $('authTip').innerHTML =
        '还没有配置云端。请把 <code>config.js</code> 里的 ' +
        '<code>supabaseUrl</code> 和 <code>supabaseAnonKey</code> 填上，' +
        '填好后即可跨设备同步收藏和影视源。';
      $('authState').innerHTML = '<div>· 不配置也能正常看片；收藏、观看历史需要登录账号后才能使用</div>';
      return;
    }
    $('authTip').textContent = logged
      ? '已登录，收藏和自定义影视源会自动同步到云端。'
      : '登录后，收藏和自定义影视源会自动同步到云端，换手机、换电脑都还在。';
    $('authState').innerHTML = logged
      ? '<div>· 当前账号：<b>' + esc(window.Cloud.email() || '') + '</b></div>' +
        '<div>· 在一台设备上收藏，其他设备登录同一账号后会自动出现</div>'
      : '<div>· 没有账号就先点「注册新账号」，用一个常用邮箱即可</div>' +
        '<div>· 不登录也能正常看片，但收藏、观看历史需要登录后才能使用</div>';
  }

  function doLogin() {
    var em = $('authEmail').value.trim();
    var pw = $('authPw').value;
    var m = $('authMsg');
    if (!em || !pw) { m.className = 'msg err'; m.textContent = '请填写邮箱和密码'; return; }
    m.className = 'msg'; m.textContent = '正在登录…';
    window.Cloud.signIn(em, pw).then(function () {
      m.className = 'msg ok'; m.textContent = '登录成功，正在同步…';
      updateUserBtn();
      return syncAll().then(function () {
        return loadFavs();      // 登录后把收藏 / 进度读回来
      }).then(function () {
        renderAuth();
        renderResume();
        toast('登录成功，收藏和影视源已同步');
      });
    }).catch(function (e) {
      m.className = 'msg err'; m.textContent = '登录失败：' + e.message;
    });
  }

  function doSignup() {
    var em = $('authEmail').value.trim();
    var pw = $('authPw').value;
    var m = $('authMsg');
    if (!em || !pw) { m.className = 'msg err'; m.textContent = '请填写邮箱和密码'; return; }
    if (pw.length < 6) { m.className = 'msg err'; m.textContent = '密码至少 6 位'; return; }
    m.className = 'msg'; m.textContent = '正在注册…';
    window.Cloud.signUp(em, pw).then(function (r) {
      if (r && r.loggedIn) {
        m.className = 'msg ok'; m.textContent = '注册成功，正在同步…';
        updateUserBtn();
        return syncAll().then(function () {
          return loadFavs();
        }).then(function () {
          renderAuth();
          renderResume();
          toast('注册成功，已自动登录');
        });
      }
      m.className = 'msg ok';
      m.textContent = '注册成功！请去邮箱点确认链接，然后回到这里点「登录」。';
    }).catch(function (e) {
      m.className = 'msg err'; m.textContent = '注册失败：' + e.message;
    });
  }

  function doLogout() {
    window.Cloud.signOut().then(function () {
      // 退出后清掉内存里的账号数据，免得未登录还能看到刚才那份收藏 / 进度
      S.favs = []; S.favKeys = {}; S.hisList = []; P.map = {};
      updateUserBtn();
      renderAuth();
      toast('已退出登录');
    });
  }

  /* ------------------------------------------------ 页面切换 */

  function showPage(name) {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var el = $('page-' + name);
    if (el) el.classList.add('active');
    if (TABS.indexOf(name) >= 0) {
      S.cur = name;
      document.querySelectorAll('[data-nav]').forEach(function (a) {
        a.classList.toggle('active', a.dataset.nav === name);
      });
      // 顶栏分类高亮 / 离开首页时停掉轮播定时器
      renderTopNav();
      if (name !== 'home') stopHero();
    }
    window.scrollTo(0, 0);
  }

  function go(name) {
    showPage(name);
    if (name === 'home') loadHome();
    else if (name === 'cats') loadCatPage();
    else if (name === 'fav') loadFavs();
    else if (name === 'history') loadHistory();
    else if (name === 'mine') { renderMine(); loadIndexStatus(); }
  }

  /* ------------------------------------------------ 影视源
     不再让用户先挑源：所有源在后台合并成一份片单，用户看到的就是「片」。

     这里只保留两件事：
     1. 拉一次源清单（拿源名字，给详情页 / 播放器的线路条显示）
     2. 拉合并后的统一分类树（/feedcats），导航和筛选都用它 */

  function loadSites() {
    return api('/sites').then(function (r) {
      S.sites = (r.ok && r.sites) || [];
      if (!S.site && S.sites.length) S.site = S.sites[0].key;
      return S.sites;
    });
  }

  // 源 key → 显示名
  function siteName(key) {
    var it = (S.sites || []).filter(function (x) { return x.key === key; })[0];
    return it ? it.name : (key || '未知源');
  }

  function loadIndexStatus() {
    // 手机端独立运行：没有预索引这回事
    if (isLocal()) {
      var el0 = $('indexStatus');
      if (el0) { el0.innerHTML = ''; el0.style.display = 'none'; }
      return;
    }
    var box0 = $('indexStatus');
    if (box0) box0.style.display = '';
    api('/index/status').then(function (r) {
      if (!r.ok || !r.index) return;
      var it = r.index, label;
      if (it.running) {
        var done = 0, tot = 0, sites = it.sites || {};
        Object.keys(sites).forEach(function (k) { tot++; if (sites[k].state === '完成') done++; });
        label = '正在建立索引 ' + done + '/' + tot;
      } else if (it.done) {
        label = '已索引 ' + it.total + ' 条';
      } else {
        label = '尚未建立索引';
      }
      var el = $('indexStatus');
      if (!el) return;
      el.innerHTML = '<span>' + esc(label) + '</span>' +
        '<button id="idxRefresh" title="重新抓取最新列表">刷新</button>';
      var btn = $('idxRefresh');
      if (btn) btn.onclick = function () {
        api('/index/refresh').then(function () {
          toast('已开始后台抓取，稍后浏览 / 搜索即可秒开');
          loadIndexStatus();
        });
      };
      // 索引刚建完：分类清单会变（点不开的空分类被剔除了），重新拉一次
      if (S.idxWasRunning && !it.running) {
        S.feedCats = [];
        loadFeedCats();
      }
      S.idxWasRunning = !!it.running;
      clearTimeout(S.idxTimer);
      if (it.running) S.idxTimer = setTimeout(loadIndexStatus, 5000);
    });
  }

  /* 各源合并后的分类树：/feedcats 直接给两级结构，前端拿来就能渲染 */
  function loadFeedCats() {
    if (S.feedCats.length) { renderCats(); renderTopNav(); return Promise.resolve(); }
    function apply(r) {
      S.feedCats = (r.ok && r.list) || [];
      S.feedSites = (r.ok && r.sites) || [];
      renderCats();
      renderTopNav();
    }
    // 先用缓存的分类树把菜单铺出来（即使离线也有分类可点）
    var pre = CACHE ? CACHE.feedCatsGet().then(function (c) {
      if (c && c.data && !S.feedCats.length) apply(c.data);
    }).catch(function () {}) : Promise.resolve();
    var net = api('/feedcats').then(function (r) {
      if (r && r.ok) { if (CACHE) CACHE.feedCatsPut(r); apply(r); }
    });
    return pre.then(function () {
      if (S.feedCats.length) return;   // 缓存已经有了，网络在后台刷新
      return net;
    });
  }

  /* 分类拆成两级：一级（电影/电视剧/综艺…）+ 其下的二级（喜剧片/国产剧…） */
  function catTree() {
    var tops = [], kids = {};
    S.feedCats.forEach(function (c) {
      tops.push({ id: c.id, name: c.name });
      if (c.kids && c.kids.length) kids[c.id] = c.kids.slice();
    });
    return { tops: tops, kids: kids };
  }

  function renderCats() {
    var t = catTree();
    var bar1 = $('catLv1'), bar2 = $('catLv2');
    if (!bar1 || !bar2) return;

    // 默认落在第一个一级分类上：否则初始是不带分类的全量列表，
    // 看起来会和首页一模一样（用户提的问题）。
    if (S.catTop === '' && t.tops.length) {
      S.catTop = t.tops[0].id;
      S.catType = '';
      S.catPage = 1;
    }

    // 一级只有真正的大类，不再放「全部」——想看全部去首页的「最新上架」，
    // 否则这个分类页和首页内容会一模一样
    var h1 = '';
    t.tops.forEach(function (c) {
      h1 += '<div class="chip ' + (S.catTop === c.id ? 'active' : '') + '" data-t="' +
        esc(c.id) + '">' + esc(c.name) + '</div>';
    });
    bar1.innerHTML = h1;
    bar1.querySelectorAll('.chip').forEach(function (el) {
      el.onclick = function () {
        S.catTop = el.dataset.t;
        S.catType = '';
        S.catPage = 1;
        renderCats();
        loadCatList();
      };
    });

    // 二级：选中一级且有子分类才出现
    var subs = t.kids[S.catTop] || [];
    var row2 = $('catRow2');
    if (row2) row2.classList.toggle('hide', !subs.length);
    if (!subs.length) {
      bar2.innerHTML = '';
      return;
    }
    var h2 = '<div class="chip ' + (S.catType === '' ? 'active' : '') + '" data-t="">全部</div>';
    subs.forEach(function (c) {
      h2 += '<div class="chip ' + (S.catType === c.id ? 'active' : '') + '" data-t="' +
        esc(c.id) + '">' + esc(c.name) + '</div>';
    });
    bar2.innerHTML = h2;
    bar2.querySelectorAll('.chip').forEach(function (el) {
      el.onclick = function () {
        S.catType = el.dataset.t;
        S.catPage = 1;
        renderCats();
        loadCatList();
      };
    });
  }

  /* 顶栏导航：首页 + 影视源的一级分类（最多 6 个）+ 分类。
     分类清单是跟着源走的，所以每次拿到分类都重建一次。 */
  function renderTopNav() {
    var nav = $('topNav');
    if (!nav) return;
    var picks = catTree().tops.slice(0, 6);
    var inPick = picks.some(function (c) { return c.id === S.catTop; });
    var html = '<a data-nav="home"' + (S.cur === 'home' ? ' class="active"' : '') + '>首页</a>';
    picks.forEach(function (c) {
      var on = (S.cur === 'cats' && S.catTop === c.id);
      html += '<a class="navcat' + (on ? ' active' : '') + '" data-t="' + esc(c.id) + '">' +
        esc(c.name) + '</a>';
    });
    html += '<a data-nav="cats"' +
      (S.cur === 'cats' && !inPick ? ' class="active"' : '') + '>分类</a>';
    nav.innerHTML = html;
    nav.querySelectorAll('.navcat').forEach(function (el) {
      el.onclick = function () {
        S.catTop = el.dataset.t;
        S.catType = '';
        S.catPage = 1;
        go('cats');
        renderTopNav();
      };
    });
    nav.querySelectorAll('[data-nav]').forEach(function (el) {
      el.onclick = function () { go(el.dataset.nav); };
    });
  }

  function loadCatPage() {
    // 先拿到统一分类（renderCats 会把默认分类选好）再取列表
    return loadFeedCats().then(function () {
      loadCatList();
    });
  }

  function loadCatList() {
    var box = $('catGrid');
    if (!box) return;
    box.innerHTML = '<div class="loading">正在加载…</div>';
    $('catPager').innerHTML = '';
    // 选了细分用细分，否则用一级（后端会把多个源的同名分类合在一起）
    var cat = S.catTop || '';
    var sub = cat ? (S.catType || '') : '';
    var painted = false;
    feedSWR({ cat: cat, sub: sub, page: S.catPage }, function (r, meta) {
      if (!r || !r.ok) {
        if (!painted) box.innerHTML = '<div class="empty">' + esc((r && r.error) || '加载失败') + '</div>';
        return;
      }
      painted = true;
      var list = r.list || [];
      list.forEach(rememberCands);
      renderGridInto(box, $('catPager'), list, r.indexed, S.catPage, !!cat,
        function (p) { S.catPage = p; loadCatList(); });
      if (!meta.cached) preheatPosters(list.slice(0, 12));
    });
  }

  /* ------------------------------------------------ 影视列表 */

  // 卡片第二行：年份 · 类型（评分已经挪到封面右下角，这里不再重复）
  function metaLine(v) {
    var t = [];
    if (v.year) t.push(esc(v.year));
    if (v.type) t.push(esc(v.type));
    return t.length ? '<div class="cap-m">' + t.join(' · ') + '</div>' : '';
  }

  function cardHtml(v, siteKey, withDel, opt) {
    opt = opt || {};
    return '<div class="card" data-id="' + esc(v.id) + '"' +
      (siteKey ? ' data-site="' + esc(siteKey) + '"' : '') + '>' +
      (opt.ck ? '<div class="ck"></div>' : '') +
      (withDel ? '<div class="xdel" data-del="' + esc(v.key) + '" title="取消收藏">✕</div>' : '') +
      '<div class="pic"' + picAttr(v.pic) + '>' +
      (v.pic ? '' : '<div class="ph">暂无封面</div>') +
      // 左上角：更新状态（更新至 12 集 / 全 24 集）
      (v.remarks ? '<div class="rem">' + esc(v.remarks) + '</div>' : '') +
      // 右下角：评分
      (v.score ? '<div class="score">' + esc(v.score) + '</div>' : '') +
      // 左下角：聚合搜索时标出「几个源有」
      (opt.cnt > 1 ? '<div class="cnt">' + opt.cnt + ' 源</div>' : '') +
      (opt.srcs && opt.srcs.length
        ? '<div class="srcs">' + opt.srcs.slice(0, 3).map(function (s) {
            return '<i>' + esc(s) + '</i>';
          }).join('') + '</div>'
        : '') +
      '</div>' +
      '<div class="cap">' +
      '<div class="cap-t">' + esc(v.name) + '</div>' +
      metaLine(v) +
      '</div>' +
      '</div>';
  }

  /* ------------------------------------------------ 首页：分区流
     原来首页是一页 24 条 + 上一页/下一页，想找片只能一直翻。
     现在改成几段横滑分区：继续观看 / 最新上架 / 各一级分类精选。 */

  function homeMsg(text, withBtn) {
    var box = $('homeSecs');
    if (box) box.innerHTML = '<div class="home-empty">' + esc(text) +
      (withBtn ? '<br><br><button class="btn-primary" id="goSet">去添加影视源</button>' : '') +
      '</div>';
    var b = $('goSet');
    if (b) b.onclick = openSet;
    var rs = $('homeResume');
    if (rs) rs.innerHTML = '';
    stopHero();
    var hb = $('homeHero');
    if (hb) { hb.innerHTML = ''; hb.classList.remove('show'); }
    HERO.list = []; HERO.n = 0;
  }

  /* 继续观看：本机进度里最近看过的几部（按时间倒序）

     进度是按「影视源 + 影片ID」存的（换一个源看同一部片就会多存一条），
     直接把整张表铺出来，同一部片就会在首页出现好几次。
     这里按片名归一，同一部片只留最近看的那条。 */
  function resumeList() {
    var arr = [];
    Object.keys(P.map || {}).forEach(function (k) {
      var r = P.map[k];
      if (r && r.key && r.name && (r.pos || 0) >= 5) arr.push(r);
    });
    arr.sort(function (a, b) { return (b.time || 0) - (a.time || 0); });
    var seen = {}, out = [];
    arr.forEach(function (r) {
      var nk = normName(r.name) || ('#k#' + (r.key || ''));
      var old = seen[nk];
      if (old) {
        // 留下的那条若缺封面 / 时长，用另一条源的补上，免得卡片显示「暂无封面」。
        // 改的是复制出来的展示副本，不动 P.map 里那条真实的进度记录。
        if (!old.pic && r.pic) old.pic = r.pic;
        if (!old.dur && r.dur) old.dur = r.dur;
        return;
      }
      var cp = {};
      for (var k in r) cp[k] = r[k];
      seen[nk] = cp;
      out.push(cp);
    });
    return out.slice(0, 10);
  }

  function renderResume() {
    var box = $('homeResume');
    if (!box) return;
    // 未登录不显示「继续观看」——这是账号级功能
    if (!cloudReady()) { box.innerHTML = ''; return; }
    var list = resumeList();
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="home-sec resume-sec">' +
      '<div class="sec-head"><h3>继续观看</h3><span>点卡片接着上次的位置播</span></div>' +
      '<div class="rail">' + list.map(function (r) {
        var pct = (r.dur > 0) ? Math.min(100, Math.round((r.pos / r.dur) * 100)) : 0;
        var epTxt = r.epName || ('第' + ((r.ei || 0) + 1) + '集');
        return '<div class="rcard" data-id="' + esc(r.id) + '" data-site="' + esc(r.site || '') + '">' +
          '<div class="pic"' + picAttr(r.pic) + '>' +
          (r.pic ? '' : '<div class="ph">暂无封面</div>') +
          '<div class="rgo"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>' +
          '</div>' +
          (pct ? '<div class="rprog"><i style="width:' + pct + '%"></i></div>' : '') +
          '<div class="cap"><div class="cap-t">' + esc(r.name) + '</div>' +
          '<div class="cap-m">' + esc(epTxt) + (pct ? (' · 已看 ' + pct + '%') : '') + '</div>' +
          '</div></div>';
      }).join('') + '</div></div>';
    box.querySelectorAll('.rcard').forEach(function (el) {
      el.onclick = function () { openDetail(el.dataset.id, el.dataset.site, true); };
    });
    posterFill(box);
  }

  function railCardHtml(v) {
    return '<div class="rcard" data-id="' + esc(v.id) + '" data-site="' + esc(v.site || '') + '">' +
      '<div class="pic"' + picAttr(v.pic) + '>' +
      (v.pic ? '' : '<div class="ph">暂无封面</div>') +
      (v.remarks ? '<div class="rem">' + esc(v.remarks) + '</div>' : '') +
      (v.score ? '<div class="score">' + esc(v.score) + '</div>' : '') +
      (v.srcCount > 1 ? '<div class="cnt">' + v.srcCount + ' 源</div>' : '') +
      '</div>' +
      '<div class="cap"><div class="cap-t">' + esc(v.name) + '</div>' +
      metaLine(v) + '</div></div>';
  }

  /* ---- 首页大图轮播 ----
     取最新片单里带封面的前 6 部：背景是同一张图放大模糊后的底，
     前景放清晰竖版海报 + 片名/标签 + 「立即播放」，底部胶囊指示点，5 秒自动换。 */
  var HERO = { i: 0, n: 0, list: [], timer: null };

  function stopHero() {
    if (HERO.timer) { clearInterval(HERO.timer); HERO.timer = null; }
  }

  function heroGo(i) {
    var box = $('homeHero');
    if (!box || !HERO.n) return;
    HERO.i = ((i % HERO.n) + HERO.n) % HERO.n;
    box.querySelectorAll('.hero-slide').forEach(function (s, k) {
      s.classList.toggle('on', k === HERO.i);
    });
    box.querySelectorAll('.hero-dots i').forEach(function (d, k) {
      d.classList.toggle('on', k === HERO.i);
    });
  }

  function startHero() {
    stopHero();
    if (HERO.n > 1) {
      HERO.timer = setInterval(function () { heroGo(HERO.i + 1); }, 5000);
    }
  }

  function renderHero(list) {
    var box = $('homeHero');
    if (!box) return;
    stopHero();
    var items = (list || []).filter(function (v) { return v && v.pic; }).slice(0, 6);
    HERO.list = items;
    HERO.n = items.length;
    if (!items.length) { box.innerHTML = ''; box.classList.remove('show'); return; }
    box.classList.add('show');
    box.innerHTML = items.map(function (v, i) {
      var meta = [];
      if (v.year) meta.push(esc(v.year));
      if (v.type) meta.push(esc(v.type));
      if (v.remarks) meta.push(esc(v.remarks));
      return '<div class="hero-slide' + (i === 0 ? ' on' : '') + '" data-i="' + i + '">' +
        '<div class="hero-bg"' + picAttr(v.pic) + '></div>' +
        '<div class="hero-shade"></div>' +
        '<div class="hero-in">' +
        '<div class="hero-txt">' +
        '<h2>' + esc(v.name) + '</h2>' +
        '<div class="hero-meta">' +
        (v.score ? '<span class="hs">' + esc(v.score) + '</span>' : '') +
        (meta.length ? '<span>' + meta.join(' · ') + '</span>' : '') +
        '</div>' +
        '<button class="btn-primary hero-play">' +
        '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>立即播放</button>' +
        '</div>' +
        '<div class="hero-pic"' + picAttr(v.pic) + '></div>' +
        '</div></div>';
    }).join('') +
      '<div class="hero-dots">' + items.map(function (v, i) {
        return '<i class="' + (i === 0 ? 'on' : '') + '" data-i="' + i + '"></i>';
      }).join('') + '</div>';

    posterFill(box);
    box.querySelectorAll('.hero-dots i').forEach(function (d) {
      d.onclick = function (e) {
        e.stopPropagation();
        heroGo(parseInt(d.dataset.i, 10));
        startHero();
      };
    });
    // 点海报/按钮 → 进详情（背景也算，整块可点）
    box.onclick = function (e) {
      var t = e.target;
      var slide = t.closest ? t.closest('.hero-slide') : null;
      if (!slide) return;
      var v = HERO.list[parseInt(slide.dataset.i, 10)];
      if (v) openDetail(v.id, v.site);
    };
    box.onmouseenter = stopHero;
    box.onmouseleave = startHero;
    HERO.i = 0;
    startHero();
  }

  function secShell(title, sub, moreTid) {
    return '<div class="home-sec">' +
      '<div class="sec-head"><h3>' + esc(title) + '</h3>' +
      (sub ? '<span>' + esc(sub) + '</span>' : '') +
      (moreTid ? '<button class="sec-more" data-t="' + esc(moreTid) + '">更多 →</button>' : '') +
      '</div><div class="sec-body"><div class="loading">正在加载…</div></div></div>';
  }

  function fillSec(sec, list, emptyText) {
    var body = sec.querySelector('.sec-body');
    if (!body) return;
    body.innerHTML = (list && list.length)
      ? '<div class="rail">' + list.map(railCardHtml).join('') + '</div>'
      : '<div class="home-empty">' + esc(emptyText || '这里暂时没有内容') + '</div>';
    posterFill(body);
  }

  function bindHome() {
    var root = $('homeSecs');
    if (!root) return;
    root.querySelectorAll('.rcard').forEach(function (el) {
      el.onclick = function () { openDetail(el.dataset.id, el.dataset.site); };
    });
    root.querySelectorAll('.sec-more').forEach(function (el) {
      el.onclick = function () {
        S.catTop = el.dataset.t || '';
        S.catType = '';
        S.catPage = 1;
        go('cats');
      };
    });
  }

  /* 记住「这部片各源分别是什么」，详情页 / 播放器就能直接列出线路，
     不用再为了一部片去搜一遍全站。 */
  function rememberCands(it) {
    if (it && it.name && it.cands && it.cands.length) {
      S.cands[normName(it.name)] = it.cands;
    }
  }

  // 点聚合卡：直接进详情（视频为主导），线路在详情页 / 播放器下面换
  function openMerge(it) {
    if (!it) return;
    rememberCands(it);
    var c0 = (it.cands || [])[0];
    if (c0) openDetail(c0.id, c0.site);
  }

  function loadHome() {
    renderResume();
    var secs = $('homeSecs');
    if (!secs) return Promise.resolve();
    secs.innerHTML = '<div class="loading">正在加载…</div>';
    var shell = null;      // 分类外壳只搭一次，缓存/联网各填一次内容

    function build(newest) {
      if (!S.feedCats.length) { homeMsg('还没有可用的影视源', true); return; }
      var tops = catTree().tops.slice(0, 4);
      secs.innerHTML =
        secShell('最新上架', '影视源新片，不是你的观看记录') +
        tops.map(function (c) { return secShell(c.name, '精选', c.id); }).join('');
      var all = secs.querySelectorAll('.home-sec');
      shell = all;
      // 各分类独立拉取：先缓存后联网，谁先回来谁先显示，不互相拖慢
      tops.forEach(function (c, i) {
        feedSWR({ cat: c.name, page: 1 }, function (rr, meta) {
          var list = (rr && rr.ok && rr.list) || [];
          list.forEach(rememberCands);
          fillSec(all[i + 1], list.slice(0, 18), c.name + '暂时没有内容');
          bindHome();
          if (!meta.cached && i < 2) preheatPosters(list);
        });
      });
    }

    function paint(newest) {
      if (!S.feedCats.length) return;
      if (!shell) build(newest);
      fillSec(shell[0], newest.slice(0, 18), '暂时没有内容');
      bindHome();
    }

    return loadFeedCats().then(function () {
      // 1) 先用缓存画一版（秒开）
      var pre = CACHE ? CACHE.feedGet({ page: 1 }).then(function (c) {
        if (!c || !c.data || !c.data.ok) return;
        var l = c.data.list || [];
        l.forEach(rememberCands);
        renderHero(l);
        paint(l);
      }).catch(function () {}) : Promise.resolve();
      // 2) 联网刷新：有新内容就替换，失败则保留缓存
      return pre.then(function () {
        return api('/feed', { page: 1 }).then(function (r) {
          if (r && r.ok) {
            offlineBar('');
            if (CACHE) CACHE.feedPut({ page: 1 }, r);
            var list = r.list || [];
            list.forEach(rememberCands);
            renderHero(list);
            if (!S.feedCats.length) { homeMsg('还没有可用的影视源', true); return; }
            paint(list);
            preheatPosters(list);
          } else if (!shell) {
            homeMsg((r && r.error) || '加载失败');
          }
        });
      });
    });
  }

  /* 网格渲染通用版：分类页用；列表项是各源合并后的「片」，点进详情再换线路 */
  function renderGridInto(grid, pager, list, indexed, page, hasType, goPage) {
    if (!list.length) {
      var msg = page > 1
        ? '没有更多内容了'
        : (hasType
            ? (indexed === false ? '正在建立索引，这个分类稍后再点一下'
                                 : '该分类下暂时没有内容，换个分类看看')
            : '暂时没有取到内容，稍后再点一下试试');
      grid.innerHTML = '<div class="empty">' + msg + '</div>';
      pager.innerHTML = page > 1
        ? '<button class="pgPrev">上一页</button><span class="pnum">第 ' + page + ' 页</span>' : '';
      var pv = pager.querySelector('.pgPrev');
      if (pv) pv.onclick = function () { goPage(page - 1); };
      return;
    }
    grid.innerHTML = list.map(function (v) {
      return cardHtml(v, null, false, {
        cnt: v.srcCount,
        srcs: (v.cands || []).map(function (c) { return c.siteName; })
      });
    }).join('');
    grid.querySelectorAll('.card').forEach(function (el, i) {
      el.onclick = function () { openMerge(list[i]); };
    });
    posterFill(grid);
    pager.innerHTML =
      '<button class="pgPrev" ' + (page <= 1 ? 'disabled' : '') + '>上一页</button>' +
      '<span class="pnum">第 ' + page + ' 页</span>' +
      '<button class="pgNext">下一页</button>';
    pager.querySelector('.pgPrev').onclick = function () { if (page > 1) goPage(page - 1); };
    pager.querySelector('.pgNext').onclick = function () { goPage(page + 1); };
  }

  /* ------------------------------------------------ 搜索

     「聚合视图」把同一部片在各源的结果合并成一张卡，卡片上标出哪几个源有，
     点开选一个源就能播；「分源视图」仍按源分组，方便看某个源的全貌。 */

  var HIS_KEY = 'dxk.searchHis';

  function getSearchHis() {
    try { return JSON.parse(localStorage.getItem(HIS_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function pushSearchHis(wd) {
    var arr = getSearchHis().filter(function (x) { return x !== wd; });
    arr.unshift(wd);
    try { localStorage.setItem(HIS_KEY, JSON.stringify(arr.slice(0, 12))); } catch (e) {}
  }
  function clearSearchHis() {
    try { localStorage.removeItem(HIS_KEY); } catch (e) {}
    renderSearchDrop();
  }

  // 归一化片名：把不同源的同一部片合并到一起
  function normName(n) {
    return String(n || '')
      .replace(/[\s·・:：\-—_()（）\[\]【】《》"'“”'']/g, '')
      .toLowerCase();
  }

  function mergeGroups(groups) {
    var map = {}, order = [];
    groups.forEach(function (g) {
      (g.list || []).forEach(function (v) {
        var k = normName(v.name);
        if (!k) return;
        if (!map[k]) {
          map[k] = { name: v.name, pic: v.pic, remarks: v.remarks, year: v.year, cands: [] };
          order.push(k);
        }
        var it = map[k];
        if (!it.pic && v.pic) it.pic = v.pic;
        if (!it.remarks && v.remarks) it.remarks = v.remarks;
        if (!it.year && v.year) it.year = v.year;
        it.cands.push({ site: g.site, siteName: g.siteName, source: g.source,
                        id: v.id, name: v.name, pic: v.pic, remarks: v.remarks,
                        year: v.year, type: v.type, score: v.score });
      });
    });
    return order.map(function (k) { return map[k]; });
  }

  function doSearch(wd) {
    wd = (wd != null ? wd : $('kw').value).trim();
    if (!wd) { toast('请输入关键词'); return; }
    $('kw').value = wd;
    hideSearchDrop();
    pushSearchHis(wd);
    S.search.wd = wd;
    showPage('search');
    $('searchResult').innerHTML =
      '<div class="loading">正在多个影视源中搜索「' + esc(wd) + '」，请稍候…</div>';
    api('/search', { wd: wd }).then(function (r) {
      if (!r.ok) {
        $('searchResult').innerHTML = '<div class="empty">' + esc(r.error || '搜索失败') + '</div>';
        return;
      }
      S.search.groups = r.groups || [];
      S.search.total = r.total || 0;
      renderSearch();
    });
  }

  function renderSearch() {
    var gs = S.search.groups, wd = S.search.wd;
    if (!gs.length) {
      $('searchSub').textContent = '「' + wd + '」';
      $('searchResult').innerHTML =
        '<div class="empty">没有搜到「' + esc(wd) + '」<br>换个关键词试试</div>';
      return;
    }
    $('searchSub').textContent = '「' + wd + '」共 ' + S.search.total +
      ' 个结果 · ' + gs.length + ' 个源';
    if (S.search.view === 'group') renderSearchGroup();
    else renderSearchMerge();
  }

  // 聚合视图（默认）
  function renderSearchMerge() {
    var list = mergeGroups(S.search.groups);
    var html = '<div class="search-tip">已把各源结果合并去重 · 卡片右上角标出「哪几个源有这部片」</div>' +
      '<div class="grid">' + list.map(function (it) {
        return cardHtml(
          { id: it.cands[0].id, name: it.name, pic: it.pic, remarks: it.remarks },
          it.cands[0].site, false,
          { cnt: it.cands.length, srcs: it.cands.map(function (c) { return c.siteName; }) }
        );
      }).join('') + '</div>';
    var box = $('searchResult');
    box.innerHTML = html;
    box.querySelectorAll('.card').forEach(function (el, i) {
      el.onclick = function () { openMerge(list[i]); };
    });
  }

  // 分源视图
  function renderSearchGroup() {
    var html = '<div class="search-tip">按影视源分组显示</div>';
    S.search.groups.forEach(function (g) {
      html += '<div class="grp-title">' + esc(g.siteName) +
        '<span>' + esc(g.source || '') + ' · ' + g.list.length + ' 个</span></div>' +
        '<div class="grid">' +
        g.list.map(function (v) { return cardHtml(v, g.site, false); }).join('') + '</div>';
    });
    var box = $('searchResult');
    box.innerHTML = html;
    box.querySelectorAll('.card').forEach(function (el) {
      el.onclick = function () { openDetail(el.dataset.id, el.dataset.site); };
    });
  }

  /* ---- 选源弹窗：聚合搜索点开多源卡片 / 播放中一键换源 ---- */

  function openPick(title, cands, curD) {
    S.pick = { title: title, cands: cands, cur: curD };
    $('pickTitle').textContent = curD ? ('换源 · ' + title) : ('选择播放源 · ' + title);
    $('pickTip').textContent = curD
      ? '当前源不顺畅时，选一个别的源接着看（集数会尽量对上）。'
      : '这部片在 ' + cands.length + ' 个源里都有，选一个开始播放。';
    $('pickBox').innerHTML = cands.map(function (c, i) {
      var isCur = curD && c.site === curD.site;
      return '<div class="sp' + (isCur ? ' cur' : '') + '" data-i="' + i + '">' +
        '<div><b>' + esc(c.siteName) + '</b></div>' +
        '<span>' + esc(c.remarks || c.year || '') + '</span></div>';
    }).join('');
    $('pickBox').querySelectorAll('.sp').forEach(function (el) {
      el.onclick = function () {
        var c = cands[parseInt(el.dataset.i, 10)];
        closePick();
        if (curD) {
          // 换源：记住当前看到第几集、第几秒，新源上接着播
          S.pendingPlay = { gi: curD.gi || 0, ei: curD.ei || 0, pos: curD.pos || 0 };
          S.curEp = null;
          S.tried[c.site] = 1;
          toast('已换成「' + c.siteName + '」');
        }
        openDetail(c.id, c.site);
      };
    });
    $('pickModal').classList.add('show');
  }
  function closePick() { $('pickModal').classList.remove('show'); }

  /* ---- 搜索框下拉：搜索历史 + 热门推荐 ---- */

  function renderSearchDrop() {
    var his = getSearchHis();
    var html = '';
    if (his.length) {
      html += '<div class="sd-head"><b>搜索历史</b><button id="sdClear">清空</button></div>' +
        '<div class="sd-tags">' + his.map(function (h) {
          return '<span data-w="' + esc(h) + '">' + esc(h) + '</span>';
        }).join('') + '</div>';
    }
    html += '<div class="sd-head"><b>热门推荐</b></div>' +
      '<div class="sd-tags" id="sdHot"><span class="sd-empty">正在加载…</span></div>';
    var d = $('searchDrop');
    d.innerHTML = html;
    d.classList.add('show');
    var c = $('sdClear');
    if (c) c.onclick = function (e) { e.stopPropagation(); clearSearchHis(); };
    bindDropTags(d);
    api('/hot', { limit: 24 }).then(function (r) {
      var hot = (r.ok && r.list) || [];
      var box = $('sdHot');
      if (!box) return;
      box.innerHTML = hot.length
        ? hot.map(function (h) {
            return '<span class="hot" data-w="' + esc(h) + '">' + esc(h) + '</span>';
          }).join('')
        : '<span class="sd-empty">索引建好后这里会有推荐</span>';
      bindDropTags(d);
    });
  }

  function bindDropTags(root) {
    root.querySelectorAll('.sd-tags span[data-w]').forEach(function (el) {
      el.onclick = function () { doSearch(el.dataset.w); };
    });
  }

  function hideSearchDrop() { $('searchDrop').classList.remove('show'); }

  /* ------------------------------------------------ 详情 */

  function openDetail(id, siteKey, resume) {
    var site = siteKey || S.site;
    showPage('detail');
    $('detailBox').innerHTML = '<div class="loading">正在获取详情…</div>';
    api('/detail', { site: site, id: id }).then(function (r) {
      if (!r.ok) {
        $('detailBox').innerHTML = '<div class="empty">' + esc(r.error || '获取失败') + '</div>';
        return;
      }
      var d = r.detail;
      d.site = site;
      d.key = site + ':' + d.id;
      S.detail = d;
      loadSkip(d);
      renderDetail(d);
      saveHistory(d);
      // 换源过来的：跳过进度逻辑，直接跳到原来那一集的同一时间点
      var pp = S.pendingPlay;
      S.pendingPlay = null;
      if (pp) {
        var n = (d.groups || []).length;
        var gi = Math.max(0, Math.min(pp.gi || 0, n - 1));
        var g = d.groups && d.groups[gi];
        var ei = g ? Math.max(0, Math.min(pp.ei || 0, g.episodes.length - 1)) : 0;
        play(d, gi, ei, pp.pos || 0);
        return;
      }
      // 本机先渲染，同时去云端取最新进度（换设备登录同一账号也能接着看）
      return cloudProgGet(d.key).then(function (c) {
        if (c) {
          var cr = progFromCloud(c);
          // 比的是「同一部片」的最近一条（可能来自别的源），不是本条 key 的
          var cur = progOf(d);
          if (cr.time > ((cur && cur.time) || 0)) {
            P.map[d.key] = cr;
            progSaveLocal(cr);
            loadSkip(d);
            refreshResume(d);
          }
        }
        refreshResume(d);
        if (resume) startFromProgress(d);
      });
    });
  }

  // 把某条进度里的片头/片尾设置读进 S.skip（片头片尾标记跟着源走，只认这个源的）
  function loadSkip(d) {
    var rec = P.map[d.key] || {};
    S.skip = { intro: rec.intro || 0, outro: rec.outro || 0 };
  }

  /* 找这部片看到哪了

     进度是按「影视源 + 影片ID」存的，所以在某个源上看过的片，从别的源
     再打开时按 key 找不到，会显示成「播放第一集」——看着像进度丢了。
     这里先按 key 精确找；找不到再按片名归一找最新的那条（换源看过的同一部片）。 */
  function progOf(d) {
    var rec = P.map[d.key];
    if (rec) return rec;
    var nk = normName(d.name);
    if (!nk) return null;
    var best = null;
    Object.keys(P.map || {}).forEach(function (k) {
      var r = P.map[k];
      if (!r || normName(r.name) !== nk) return;
      if (!best || (r.time || 0) > (best.time || 0)) best = r;
    });
    return best;
  }

  /* 续播目标：进度可能来自另一个源，集数划分未必一样，
     索引越界就退回第 1 集，免得点了「继续播放」没任何反应。 */
  function resumeTarget(d) {
    var rec = progOf(d);
    if (!rec || (rec.pos || 0) <= 5) return null;
    var gs = d.groups || [];
    var gi = Math.max(0, Math.min(rec.gi || 0, gs.length - 1));
    var eps = (gs[gi] && gs[gi].episodes) || [];
    var ei = Math.max(0, Math.min(rec.ei || 0, eps.length - 1));
    var ep = eps[ei];
    return {
      rec: rec, gi: gi, ei: ei, pos: rec.pos, same: rec.key === d.key,
      label: (ep && ep.name) || rec.epName || ('第' + (ei + 1) + '集')
    };
  }

  // 详情页按钮文案跟着进度走
  function refreshResume(d) {
    var b = $('btnPlayFirst');
    if (!b) return;
    var t = resumeTarget(d);
    if (t) {
      b.textContent = '继续播放 · ' + t.label + '  ' + fmtTime(t.pos);
    } else {
      b.textContent = '播放第一集';
    }
  }

  // 从上次的位置、集数接着播
  function startFromProgress(d) {
    var t = resumeTarget(d);
    if (t) {
      play(d, t.gi, t.ei, t.pos);
      toast(t.same ? '已从上次看到的地方继续播放' : '按同一部片在别处看到的进度接着播');
    } else {
      play(d, 0, 0, 0);
    }
  }

  function renderDetail(d) {
    var faved = cloudReady() && !!S.favKeys[d.key];
    EPCH.sel = null;      // 换剧时退出缓存模式

    // 片名下面的标签：评分（金底）+ 年份 / 类型 / 地区 / 语言
    var chips = [];
    if (d.score) chips.push('<span class="hs">' + esc(d.score) + '</span>');
    [d.year, d.type, d.area, d.lang].forEach(function (x) {
      if (x) chips.push('<span>' + esc(x) + '</span>');
    });

    // 选集单独做成一块面板：先选线路，再选集
    var hasEp = !!(d.groups && d.groups.length);
    var eps = hasEp
      ? '<div class="d-eps">' +
        '<div class="d-eps-head">' +
        '<b>选集</b><span class="d-eps-sub" id="dEpsSub"></span>' +
        '<div class="d-line line-tabs">' + d.groups.map(function (g, i) {
          return '<div class="chip ' + (i === 0 ? 'active' : '') + '" data-g="' + i + '">' +
            esc(g.from) + '</div>';
        }).join('') + '</div>' +
        '<button class="btn-ghost btn-cache" id="btnCacheEps">缓存</button>' +
        '</div>' +
        '<div class="ep-box" id="epBox"></div>' +
        '<div class="ep-cache-bar" id="epCacheBar"></div>' +
        '</div>'
      : '<div class="empty">该影片没有可播放的资源</div>';

    $('detailBox').innerHTML =
      '<div class="detail-head">' +
      '<div class="detail-pic"' + picAttr(d.pic) + '>' +
      (d.score ? '<div class="dp-score">' + esc(d.score) + '</div>' : '') +
      '</div>' +
      '<div class="detail-info">' +
      '<h2>' + esc(d.name) + '</h2>' +
      (chips.length ? '<div class="d-chips">' + chips.join('') + '</div>' : '') +
      (d.director ? '<div class="meta"><b>导演：</b>' + esc(d.director) + '</div>' : '') +
      (d.actor ? '<div class="meta"><b>主演：</b>' + esc(d.actor) + '</div>' : '') +
      (d.content ? '<div class="desc">' + esc(d.content) + '</div>' : '') +
      '<div class="detail-acts">' +
      '<button class="btn-primary btn-play" id="btnPlayFirst">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放第一集</button>' +
      '<button class="btn-ghost" id="btnFav">' + (faved ? '★ 已收藏' : '☆ 收藏') + '</button>' +
      '<button class="btn-ghost" id="btnBack">返回</button>' +
      '</div>' +
      // 播放源：附在播放按钮下面，先看片、再挑线路
      '<div class="d-srcs" id="dSrcs"></div>' +
      '</div></div></div>' + eps;

    renderDetailSrcs(d);

    if (!hasEp) { bindDetail(d); return; }

    S.curGroup = 0;
    renderEps();

    $('detailBox').querySelectorAll('.d-line .chip').forEach(function (el) {
      el.onclick = function () {
        S.curGroup = parseInt(el.dataset.g, 10);
        if (EPCH.sel) EPCH.sel = {};      // 换线路后原来勾的集数不再对应
        $('detailBox').querySelectorAll('.d-line .chip').forEach(function (x) {
          x.classList.toggle('active', x === el);
        });
        renderEps();
      };
    });
    bindDetail(d);
  }

  function bindDetail(d) {
    var pf = $('btnPlayFirst');
    if (pf) pf.onclick = function () { startFromProgress(d); };
    var bf = $('btnFav');
    if (bf) bf.onclick = function () { toggleFav(d, bf); };
    var bb = $('btnBack');
    if (bb) bb.onclick = function () { showPage(S.cur); };
    var bc = $('btnCacheEps');
    if (bc) bc.onclick = function () { epCacheMode(!EPCH.sel); };
  }

  /* ---- 批量选集缓存：进「缓存模式」后点分集是勾选，不会误触播放 ---- */
  var EPCH = { sel: null };

  function epCacheMode(on) {
    EPCH.sel = on ? {} : null;
    var b = $('btnCacheEps');
    if (b) b.classList.toggle('active', !!on);
    renderEps();
  }

  function renderEpCacheBar() {
    var bar = $('epCacheBar');
    if (!bar) return;
    if (!EPCH.sel) { bar.innerHTML = ''; bar.classList.remove('show'); return; }
    var n = Object.keys(EPCH.sel).length;
    bar.classList.add('show');
    bar.innerHTML =
      '<span class="ec-n">已选 <b>' + n + '</b> 集</span>' +
      '<button data-a="all">全选</button>' +
      '<button data-a="inv">反选</button>' +
      '<button data-a="none">取消</button>' +
      '<button class="ec-go" data-a="go">开始缓存</button>';
    bar.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () { epCacheAct(b.dataset.a); };
    });
  }

  function epCacheAct(a) {
    var g = S.detail && S.detail.groups[S.curGroup];
    if (!g || !EPCH.sel) return;
    if (a === 'all') g.episodes.forEach(function (e, i) { EPCH.sel[i] = 1; });
    else if (a === 'none') EPCH.sel = {};
    else if (a === 'inv') g.episodes.forEach(function (e, i) {
      if (EPCH.sel[i]) delete EPCH.sel[i]; else EPCH.sel[i] = 1;
    });
    else if (a === 'go') { epCacheGo(); return; }
    renderEps();
  }

  function epCacheGo() {
    var d = S.detail, g = d.groups[S.curGroup];
    var idx = Object.keys(EPCH.sel).map(Number).sort(function (a, b) { return a - b; });
    if (!idx.length) { toast('还没选要缓存的集数'); return; }
    var eps = idx.map(function (i) {
      return { name: g.episodes[i].name, url: g.episodes[i].url };
    });
    toast('正在解析缓存地址，请稍等…', 8000);
    api('/dl/batch', null, { site: d.site, name: d.name, key: d.key, eps: eps })
      .then(function (r) {
        if (!r.ok) { toast(r.error || '加入缓存失败', 4600); return; }
        var n = (r.ids || []).length;
        var tip = '已加入 ' + n + ' 集到缓存';
        if (r.skipped && r.skipped.length) tip += '，' + r.skipped.length + ' 集跳过';
        toast(tip + '；到「我的 → 离线下载」看进度', 5200);
        epCacheMode(false);
      });
  }

  function renderEps() {
    var g = S.detail.groups[S.curGroup];
    var box = $('epBox');
    if (!box || !g) return;
    var rec = P.map[S.detail.key];
    var lastEi = (rec && (rec.gi || 0) === S.curGroup) ? rec.ei : -1;
    var sub = $('dEpsSub');
    if (sub) sub.textContent = '共 ' + g.episodes.length + ' 集 · ' + g.from;
    var on = !!EPCH.sel;
    box.classList.toggle('picking', on);
    box.innerHTML = g.episodes.map(function (e, i) {
      var ck = on && EPCH.sel[i];
      return '<div class="ep' + (i === lastEi ? ' watched' : '') + (ck ? ' ck' : '') +
        '" data-i="' + i + '">' +
        (on ? '<i class="epck">' + (ck ? '✓' : '') + '</i>' : '') +
        esc(e.name) + '</div>';
    }).join('');
    box.querySelectorAll('.ep').forEach(function (el) {
      el.onclick = function () {
        var i = parseInt(el.dataset.i, 10);
        if (on) {
          if (EPCH.sel[i]) delete EPCH.sel[i]; else EPCH.sel[i] = 1;
          var ck = el.querySelector('.epck');
          el.classList.toggle('ck', !!EPCH.sel[i]);
          if (ck) ck.textContent = EPCH.sel[i] ? '✓' : '';
          renderEpCacheBar();
          return;
        }
        box.querySelectorAll('.ep').forEach(function (x) { x.classList.remove('playing'); });
        el.classList.add('playing');
        var at = (rec && (rec.gi || 0) === S.curGroup && rec.ei === i && rec.pos > 5) ? rec.pos : 0;
        play(S.detail, S.curGroup, i, at);
      };
    });
    renderEpCacheBar();
  }

  /* ------------------------------------------------ 播放 */

  function play(d, gi, ei, startAt) {
    var g = d.groups[gi];
    if (!g) return;
    var ep = g.episodes[ei];
    if (!ep) return;
    // 换集前先把上一集的进度落盘，避免丢进度
    if (S.curEp && (S.curEp.gi !== gi || S.curEp.ei !== ei)) flushProgress(true);
    if (!S.skip || S.curEp === null || S.curEp.d !== d) loadSkip(d);
    // 换了一部片（不是换源）时，把「试过的源」清空重新算
    var nm = normName(d.name);
    if (S.swapName !== nm) { S.tried = {}; S.swapName = nm; }
    S.tried[d.site] = 1;
    S.errCount = 0;
    S.stallN = 0;                 // 新一次播放，卡顿计数归零
    stallEnd();
    S.curEp = { d: d, gi: gi, ei: ei };
    S.seek = startAt || 0;
    S.durKnown = 0;
    showPlayer(d.name + ' · ' + ep.name, '正在解析地址…');
    renderPlayerEps(d);

    api('/play', { site: d.site, url: ep.url, ref: '' }).then(function (r) {
      if (!r.ok) {
        setHow('解析失败');
        S.playReal = ''; S.playSrc = '';
        autoSwap(r.error || '该线路无法播放');
        return;
      }
      setHow(r.how || '');
      S.playReal = r.url || '';       // 上游真实地址（离线下载用）
      S.playSrc = r.play || '';       // 本地代理地址（播放 / 投屏用）
      attach(r.play, d, ep);
    });
  }

  /* HLS 统一参数（三处播放共用）
     注意别把缓冲目标调太高：源慢的时候 hls.js 会拼命往后预取，
     反而把本就不够的带宽耗在「预取后面的片段」上，越看越卡。
     实测慢源只有 50KB/s，这里改成小缓冲、快判断、少重试，
     真放不动就交给「卡顿自动换源」去换条线路。 */
  function hlsConfig(over) {
    var cfg = {
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 32 * 1000 * 1000,
      backBufferLength: 30,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 3,
      levelLoadingTimeOut: 20000,
      fragLoadingTimeOut: 30000,
      fragLoadingMaxRetry: 3
    };
    if (over) { for (var k in over) cfg[k] = over[k]; }
    return cfg;
  }

  function attach(src, d, ep) {
    var v = $('video');
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    var isM3u8 = /\.m3u8|mpegurl/i.test(src);

    if (isM3u8 && window.Hls && window.Hls.isSupported()) {
      var hls = new window.Hls(hlsConfig());
      S.hls = hls;
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        applyStart();
        tryPlay(v);
      });
      hls.on(window.Hls.Events.LEVEL_LOADED, function (evt, data) {
        if (data && data.details && !data.details.live && data.details.totalduration) {
          S.durKnown = data.details.totalduration;
        }
      });
      hls.on(window.Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal) return;
        S.errCount = (S.errCount || 0) + 1;
        // 反复致命错误说明这个源基本没救了，交给自动换源
        if (S.errCount > 3) { setHow('这个源放不了'); autoSwap('播放中断'); return; }
        if (data.type === 'networkError') {
          setHow('网络不稳，正在重连…');
          try { hls.startLoad(); } catch (e) {}
        } else if (data.type === 'mediaError') {
          try { hls.recoverMediaError(); } catch (e) {}
        } else {
          setHow('播放中断');
        }
      });
      hls.loadSource(abs(src));
      hls.attachMedia(v);
    } else {
      v.onloadedmetadata = function () { applyStart(); tryPlay(v); };
      v.src = abs(src);
      tryPlay(v);
    }
    renderPlayerEps(d);
    updatePctl();
  }

  // 起播：万一被浏览器拦了自动播放，提示用户点一下即可
  function tryPlay(v) {
    var pr = v.play();
    if (pr && pr.catch) {
      pr.catch(function () {
        setHow('请点一下画面开始播放');
        var once = function () {
          v.removeEventListener('click', once);
          var p2 = v.play();
          if (p2 && p2.catch) p2.catch(function () {});
        };
        v.addEventListener('click', once);
      });
    }
  }

  /* ---------------- 卡顿自动换源 ----------------
     采集线路的带宽差得很远：实测快的 380KB/s（流畅播），慢的只有 57KB/s，
     4 秒的片段要下 10 秒——这种情况干等是等不来的，只能换条线路接着放。
     规则：单次卡住超过 10 秒，或这条线路反复卡到 4 次，就自动换源。 */
  var STALL_MS = 10000;

  function stallStart() {
    var v = $('video');
    // 暂停中、用户正在拖进度、已经在换源了，都不算「源慢」
    if (!S.curEp || S.swapBusy || v.paused || v.seeking) return;
    if (S.stallTimer) return;
    // 前面稳稳播了 2 分钟以上，说明这条线路其实还行，重新计数
    if (S.playAt && Date.now() - S.playAt > 120000) S.stallN = 0;
    S.stallN = (S.stallN || 0) + 1;
    if (S.stallN >= 4) { stallSwap(); return; }
    S.stallTimer = setTimeout(stallSwap, STALL_MS);
  }

  function stallEnd() {
    if (S.stallTimer) { clearTimeout(S.stallTimer); S.stallTimer = null; }
    S.playAt = Date.now();
  }

  function stallSwap() {
    stallEnd();
    if (!S.curEp || S.swapBusy) return;
    var v = $('video');
    if (v.paused || v.seeking) return;
    var t = v.currentTime || 0;
    toast('这条线路太慢，正在自动换到更快的源…', 3200);
    autoSwap('这条线路太慢', t);
  }

  /* ---------------- 多源自动切换：这个源不行就自己换一个 ---------------- */

  // 在别的源里找同名片
  function findOtherSources(name, cb) {
    var nm = normName(name);
    api('/search', { wd: name }).then(function (r) {
      var gs = (r.ok && r.groups) || [];
      var cands = [];
      gs.forEach(function (g) {
        (g.list || []).forEach(function (v) {
          if (normName(v.name) !== nm) return;
          cands.push({ site: g.site, siteName: g.siteName, source: g.source,
                       id: v.id, name: v.name, pic: v.pic, remarks: v.remarks });
        });
      });
      cb(cands);
    }).catch(function () { cb([]); });
  }

  // 播不动时自动换源（最多试 4 个源，避免死循环）
  // pos 是「卡住那一刻看到第几秒」，换源后接着放，别让用户从头看
  function autoSwap(reason, pos) {
    var ce = S.curEp;
    if (!ce || S.swapBusy) return;
    if (Object.keys(S.tried).length >= 4) {
      setHow('多个源都不行，点「换源」手动选一个');
      toast('试了 4 个源都放不了，这部片的线路可能都不通', 4200);
      return;
    }
    S.swapBusy = true;
    setHow('这个源不行，正在自动找别的源…');
    toast((reason || '当前源不可用') + '，正在自动换源…', 2800);
    var gi = ce.gi, ei = ce.ei;
    var keep = pos || 0;
    findOtherSources(ce.d.name, function (cands) {
      S.swapBusy = false;
      cands = cands.filter(function (c) { return !S.tried[c.site]; });
      if (!cands.length) {
        setHow('没找到别的源');
        toast('其他源里也没找到这部片', 3600);
        return;
      }
      var c = cands[0];
      S.tried[c.site] = 1;
      S.pendingPlay = { gi: gi, ei: ei, pos: keep };
      S.curEp = null;
      toast('已自动切到「' + c.siteName + '」', 3200);
      openDetail(c.id, c.site);
    });
  }

  // 手动换源：列出这部片的所有源，自己挑一个
  function manualSwap() {
    var ce = S.curEp;
    if (!ce) { toast('还没开始播放'); return; }
    toast('正在找这部片的其他源…', 1800);
    findOtherSources(ce.d.name, function (cands) {
      if (cands.length < 2) { toast('没找到其他可用的源', 3200); return; }
      openPick(ce.d.name, cands, { site: ce.d.site, gi: ce.gi, ei: ce.ei, pos: 0 });
    });
  }

  /* ---------------- 播放源：附在视频下面 ----------------
     点卡片进来时已经把「这部片在各源分别是什么」记在 S.cands 里了，
     所以这里不用再查，直接列出来；万一没有（比如从历史进来的），
     给一个「查找其他源」，用户点了才去查，避免每次进详情都多等一次。 */

  function switchSrc(c) {
    var ce = S.curEp, pos = 0;
    if (ce) {
      try { pos = $('video').currentTime || 0; } catch (e) {}
      flushProgress(true);               // 换源前先把当前进度落盘
      S.pendingPlay = { gi: ce.gi, ei: ce.ei, pos: pos };
      S.tried[c.site] = 1;
    } else {
      S.pendingPlay = null;
    }
    S.curEp = null;
    toast('已切换到「' + c.siteName + '」');
    openDetail(c.id, c.site);
  }

  function findSrcsFor(d, cb) {
    var nm = normName(d.name);
    var cur = (S.sites || []).filter(function (x) { return x.key === d.site; })[0];
    findOtherSources(d.name, function (list) {
      if (cur && !list.some(function (c) { return c.site === d.site; })) {
        list.unshift({ site: d.site, siteName: cur.name, id: d.id, name: d.name });
      }
      if (list.length) S.cands[nm] = list;
      cb(list);
    });
  }

  function renderDetailSrcs(d) {
    var box = $('dSrcs');
    if (!box) return;
    var cands = S.cands[normName(d.name)];
    if (!cands || !cands.length) {
      box.innerHTML = '<div class="ds-head">播放源</div>' +
        '<div class="ds-list"><div class="chip" id="dsFind">查找其他源</div></div>';
      var f = $('dsFind');
      if (f) f.onclick = function () {
        f.textContent = '正在查找…';
        findSrcsFor(d, function (list) {
          if (list.length) renderDetailSrcs(d);
          else { f.textContent = '查找其他源'; toast('没有找到其他可用的源'); }
        });
      };
      return;
    }
    var hasCur = cands.some(function (c) { return c.site === d.site; });
    var html = '<div class="ds-head">播放源<span>共 ' + cands.length + ' 个源有这部片</span></div>' +
      '<div class="ds-list">';
    if (!hasCur) {
      html += '<div class="chip cur">' + esc(siteName(d.site)) + ' ✓</div>';
    }
    html += cands.map(function (c, i) {
      var cur = c.site === d.site;
      return '<div class="chip' + (cur ? ' cur' : '') + '" data-i="' + i + '">' +
        esc(c.siteName) + (cur ? ' ✓' : '') + '</div>';
    }).join('') + '</div>';
    box.innerHTML = html;
    box.querySelectorAll('.chip[data-i]').forEach(function (el) {
      el.onclick = function () {
        var c = cands[parseInt(el.dataset.i, 10)];
        if (!c || c.site === d.site) return;
        switchSrc(c);
      };
    });
  }

  // 播放器画面下面的线路条：当前线路高亮，点别的源立刻切过去
  function renderPlayerSrcs(d) {
    var box = $('pSrcBar');
    if (!box || !d) return;
    var cands = S.cands[normName(d.name)] || [];
    if (cands.length < 2) {
      box.innerHTML = '<span class="vs-lab">线路</span>' +
        '<button class="vs-btn on" id="vsMore">' + esc(siteName(d.site)) + ' · 换源</button>';
      var b = $('vsMore');
      if (b) b.onclick = manualSwap;
      return;
    }
    box.innerHTML = '<span class="vs-lab">线路</span>' + cands.map(function (c, i) {
      var on = c.site === d.site;
      return '<button class="vs-btn' + (on ? ' on' : '') + '" data-i="' + i + '">' +
        esc(c.siteName) + '</button>';
    }).join('');
    box.querySelectorAll('.vs-btn').forEach(function (el) {
      el.onclick = function () {
        var c = cands[parseInt(el.dataset.i, 10)];
        if (!c || c.site === d.site) return;
        switchSrc(c);
      };
    });
  }

  /* ---------------- 自绘控制条：进度条 / 播放暂停 / 音量 / 倍速 / 全屏 ----------------

     原生 <video controls> 在部分内核（比如电脑版用的 WebView2）里根本不显示，
     所以进度条这些东西全部自己画，三端表现一致。 */

  var V = { speed: 1, dragging: false, timer: 0 };

  // 触摸手势总开关（「我的」页可关）
  var GEST = { on: true };
  try { GEST.on = localStorage.getItem('dxk.gesture') !== '0'; } catch (e) {}

  function vDur() {
    var v = $('video');
    return (isFinite(v.duration) && v.duration > 0) ? v.duration : (S.durKnown || 0);
  }

  // 进度条 / 时间文字
  function syncBar() {
    var v = $('video');
    var dur = vDur();
    var cur = v.currentTime || 0;
    var p = dur ? Math.min(100, (cur / dur) * 100) : 0;
    $('vCur').style.width = p + '%';
    $('vDot').style.left = p + '%';
    var bp = 0;
    try {
      if (v.buffered && v.buffered.length && dur) {
        bp = Math.min(100, (v.buffered.end(v.buffered.length - 1) / dur) * 100);
      }
    } catch (e) {}
    $('vBuf').style.width = bp + '%';
    $('vTime').textContent = fmtTime(cur) + ' / ' + (dur ? fmtTime(dur) : '--:--');
    // 直播流没有总时长，进度条就没意义了
    $('vBar').style.visibility = dur ? '' : 'hidden';
  }

  function syncPlayIcon() {
    var paused = $('video').paused;
    $('vToggle').querySelector('.i-play').classList.toggle('hide', !paused);
    $('vToggle').querySelector('.i-pause').classList.toggle('hide', paused);
    showCtl();
  }

  function syncMute() {
    var v = $('video');
    $('vVol').value = String(Math.round((v.muted ? 0 : v.volume) * 100));
    $('vMute').classList.toggle('on', v.muted || v.volume === 0);
  }

  // 鼠标不动 3 秒自动隐藏控制条（暂停时一直显示）
  function showCtl() {
    $('player').classList.remove('hide-ctl');
    clearTimeout(V.timer);
    if (!$('video').paused) {
      V.timer = setTimeout(function () { $('player').classList.add('hide-ctl'); }, 3200);
    }
  }

  function barRatio(e) {
    var r = $('vBar').getBoundingClientRect();
    var x = (e.clientX != null) ? e.clientX
      : (e.touches && e.touches[0] ? e.touches[0].clientX
        : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : r.left));
    return Math.max(0, Math.min(1, (x - r.left) / r.width));
  }

  function barSeek(e) {
    var v = $('video'), dur = vDur();
    if (!dur) return;
    try { v.currentTime = barRatio(e) * dur; } catch (err) {}
  }

  function togglePlay() {
    var v = $('video');
    if (v.paused) tryPlay(v); else v.pause();
  }

  // 倍速：0.5x – 3.0x，控制条按钮 / 倍速面板 / 「我的」页默认倍速三处联动
  function speedLabel(sp) { return (sp % 1 === 0 ? sp + 'x' : String(sp) + 'x'); }

  function setSpeed(sp) {
    sp = parseFloat(sp);
    if (!sp || !isFinite(sp)) sp = 1;
    sp = Math.round(Math.max(0.5, Math.min(3, sp)) * 20) / 20;
    V.speed = sp;
    var v = $('video');
    if (v) v.playbackRate = sp;
    var lab = speedLabel(sp);
    var b = $('vSpeed');
    if (b) { b.textContent = lab; b.classList.toggle('on', sp !== 1); }
    var r = $('vRate'); if (r) r.value = sp;
    var sv = $('spVal'); if (sv) sv.textContent = lab;
    var sr = $('setRate');
    if (sr && document.activeElement !== sr) sr.value = sp;
    var st = $('setRateVal'); if (st) st.textContent = lab;
    document.querySelectorAll('#speedPop .sp-quick button').forEach(function (x) {
      x.classList.toggle('on', parseFloat(x.dataset.r) === sp);
    });
    try { localStorage.setItem('dxk.speed', String(sp)); } catch (e) {}
  }

  /* 全屏
     电脑版：调 pywebview 把窗口真正切成全屏（WebView2 里 requestFullscreen 基本无效）；
     安卓版：隐藏状态栏 + 锁横屏（@capacitor/status-bar 与 screen-orientation 已随包安装）；
     其它环境：兜底用浏览器的 Fullscreen API。
     CSS 上的 .fs 类是主力，保证任何内核下按下去都有可见变化。 */
  var FS_ON = false;

  // Capacitor 插件的返回值是 Promise，失败（如系统禁止转屏）时不要抛出未处理的 rejection
  function psafe(p) { if (p && p.catch) p.catch(function () {}); }

  function applyFs(on) {
    FS_ON = !!on;
    var el = $('player');
    if (el) el.classList.toggle('fs', FS_ON);
    if (document.body) document.body.classList.toggle('fs-lock', FS_ON);
    var btn = $('vFull');
    if (btn) {
      btn.classList.toggle('on', FS_ON);
      btn.setAttribute('aria-label', FS_ON ? '退出全屏' : '全屏');
    }
    // 安卓 / iOS：真正锁横屏 + 隐藏状态栏
    // （插件已随 App 打包；调用失败也吞掉，界面照样铺满，不会报错）
    var P = (window.Capacitor && window.Capacitor.Plugins) || {};
    try {
      if (P.ScreenOrientation) {
        psafe(FS_ON ? P.ScreenOrientation.lock({ orientation: 'landscape' })
                    : P.ScreenOrientation.unlock());
      }
    } catch (e) {}
    try {
      if (P.StatusBar) psafe(FS_ON ? P.StatusBar.hide() : P.StatusBar.show());
    } catch (e) {}
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api.toggle_fullscreen) {
        window.pywebview.api.toggle_fullscreen();
      } else if (FS_ON && el && el.requestFullscreen) {
        var p = el.requestFullscreen();
        if (p && p.catch) p.catch(function () {});
      } else if (!FS_ON && document.fullscreenElement) {
        document.exitFullscreen();
      }
    } catch (e) {}
    // 进/退全屏都先亮一下控件，之后交给 3.2 秒的自动隐藏（全屏下顶栏/线路条/控制条都靠它显隐）
    showCtl();
  }

  function toggleFull() { applyFs(!FS_ON); }

  // 用 Esc / 系统手势退出原生全屏时，把界面状态同步回来
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && FS_ON && !window.pywebview) applyFs(false);
  });

  function keyboardVol(d) {
    var v = $('video');
    v.volume = Math.max(0, Math.min(1, Math.round((v.volume + d) * 100) / 100));
    if (v.volume > 0) v.muted = false;
    syncMute();
    try { localStorage.setItem('dxk.vol', String(Math.round(v.volume * 100))); } catch (e) {}
    toast('音量 ' + Math.round(v.volume * 100) + '%', 1200);
  }

  // 画中画：缩到屏幕角落继续播，可以去搜别的片
  function togglePip() {
    var v = $('video');
    try {
      if (document.pictureInPictureElement) { document.exitPictureInPicture(); return; }
      if (!document.pictureInPictureEnabled || !v.requestPictureInPicture) {
        toast('当前播放器内核不支持画中画', 2800);
        return;
      }
      var pr = v.requestPictureInPicture();
      if (pr && pr.catch) {
        pr.catch(function () { toast('画中画打开失败，可能是内核不支持', 3000); });
      }
    } catch (e) {
      toast('当前播放器内核不支持画中画', 2800);
    }
  }

  // 自动跳过片头片尾的开关
  function toggleAutoSkip() {
    AUTO.on = !AUTO.on;
    try { localStorage.setItem('dxk.autoskip', AUTO.on ? '1' : '0'); } catch (e) {}
    updatePctl();
    toast(AUTO.on ? '已开启：起播自动跳片头，播到片尾自动下一集'
                  : '已关闭自动跳过，片头片尾位置仍然记着', 2600);
  }

  /* ---------------- 手势（手机 / 平板）

     左半屏上下滑 = 亮度，右半屏上下滑 = 音量，左右滑 = 进度，长按 = 2 倍速 */

  var G = { press: 0, moved: false, sx: 0, sy: 0, mode: '', baseSpeed: 1,
            vol: 1, br: 1, time: 0, dur: 0, longTimer: 0, suppressClick: 0 };

  function getBright() {
    var b = 1;
    try { b = parseFloat(localStorage.getItem('dxk.bright')) || 1; } catch (e) {}
    return Math.max(0.25, Math.min(1.6, b));
  }
  function applyBright(b) {
    G.br = Math.max(0.25, Math.min(1.6, b));
    var v = $('video');
    v.style.filter = G.br === 1 ? '' : ('brightness(' + G.br.toFixed(2) + ')');
  }

  function showTip(html, ms) {
    var t = $('vTip');
    t.innerHTML = html;
    t.classList.add('show');
    clearTimeout(t._t);
    if (ms) t._t = setTimeout(function () { t.classList.remove('show'); }, ms);
  }

  function bindGestures() {
    var body = $('pBody'), v = $('video');
    applyBright(getBright());

    body.addEventListener('touchstart', function (e) {
      if (!GEST.on) return;
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      G.press = 1; G.moved = false; G.mode = '';
      G.sx = t.clientX; G.sy = t.clientY;
      G.vol = v.volume; G.br = getBright();
      G.time = v.currentTime || 0; G.dur = vDur();
      G.baseSpeed = v.playbackRate || 1;
      clearTimeout(G.longTimer);
      G.longTimer = setTimeout(function () {
        if (!G.moved && G.press) {
          G.mode = 'speed';
          v.playbackRate = 2;
          showTip('快进播放 <b>2x</b>（松手恢复）', 60000);
        }
      }, 550);
    }, { passive: true });

    body.addEventListener('touchmove', function (e) {
      if (!GEST.on) return;
      if (!G.press || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - G.sx, dy = t.clientY - G.sy;
      if (G.mode === 'speed') return;                 // 长按加速时不处理滑动
      if (!G.moved && Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      G.moved = true;
      clearTimeout(G.longTimer);
      if (!G.mode) {
        G.mode = Math.abs(dx) > Math.abs(dy)
          ? 'seek'
          : (G.sx > (body.clientWidth / 2) ? 'vol' : 'bright');
      }
      var w = body.clientWidth || 1, h = body.clientHeight || 1;
      if (G.mode === 'seek') {
        if (!G.dur) return;
        var target = Math.max(0, Math.min(G.dur - 1, G.time + (dx / w) * G.dur * 0.8));
        G.pendingSeek = target;
        showTip(fmtTime(target) + ' <b>/</b> ' + fmtTime(G.dur), 0);
      } else if (G.mode === 'vol') {
        var nv = Math.max(0, Math.min(1, G.vol - dy / (h * 0.7)));
        v.volume = nv; if (nv > 0) v.muted = false;
        syncMute();
        showTip('音量 <b>' + Math.round(nv * 100) + '%</b>', 0);
      } else {
        var nb = Math.max(0.25, Math.min(1.6, G.br - dy / (h * 0.7)));
        applyBright(nb);
        showTip('亮度 <b>' + Math.round(nb * 100) + '%</b>', 0);
      }
      e.preventDefault();
    }, { passive: false });

    body.addEventListener('touchend', function () {
      clearTimeout(G.longTimer);
      if (G.mode === 'speed') {
        v.playbackRate = G.baseSpeed || 1;
      } else if (G.mode === 'seek' && G.pendingSeek != null) {
        try { v.currentTime = G.pendingSeek; } catch (e) {}
        saveProgress();
      } else if (G.mode === 'vol') {
        try { localStorage.setItem('dxk.vol', String(Math.round(v.volume * 100))); } catch (e) {}
      } else if (G.mode === 'bright') {
        try { localStorage.setItem('dxk.bright', String(G.br)); } catch (e) {}
      }
      // 手势结束时压掉随后那一下 click，避免顺手把播放暂停了
      if (G.moved || G.mode) G.suppressClick = Date.now();
      $('vTip').classList.remove('show');
      G.pendingSeek = null;
      G.press = 0; G.moved = false; G.mode = '';
    });
  }

  function initPlayerUI() {
    var v = $('video');

    // 记住上次的音量和倍速
    try {
      var sv = localStorage.getItem('dxk.vol');
      if (sv !== null) v.volume = Math.max(0, Math.min(1, parseInt(sv, 10) / 100));
      var ss = parseFloat(localStorage.getItem('dxk.speed'));
      setSpeed(ss ? ss : 1);
    } catch (e) { setSpeed(1); }
    syncMute();
    syncPlayIcon();
    syncBar();

    $('vToggle').onclick = togglePlay;
    $('vBack10').onclick = function () { seekBy(-10); };
    $('vFwd10').onclick = function () { seekBy(10); };
    $('vFull').onclick = toggleFull;
    $('vPip').onclick = togglePip;
    $('vMute').onclick = function () { v.muted = !v.muted; syncMute(); };
    $('vVol').oninput = function () {
      v.volume = Math.max(0, Math.min(1, this.value / 100));
      if (v.volume > 0) v.muted = false;
      syncMute();
      try { localStorage.setItem('dxk.vol', this.value); } catch (e) {}
    };
    $('vSpeed').onclick = function (e) {
      e.stopPropagation();
      $('speedPop').classList.toggle('show');
      showCtl();
    };
    $('vRate').oninput = function () { setSpeed(this.value); };
    $('speedPop').querySelectorAll('.sp-quick button').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        setSpeed(b.dataset.r);
        showCtl();
      };
    });
    // 点击别处收起倍速面板
    document.addEventListener('click', function (e) {
      var p = $('speedPop');
      if (!p || !p.classList.contains('show')) return;
      if (p.contains(e.target) || e.target === $('vSpeed')) return;
      p.classList.remove('show');
    });

    // 点画面播放/暂停，双击全屏（手势刚结束时压掉这一下，避免误触发）
    v.addEventListener('click', function () {
      if (G.suppressClick && Date.now() - G.suppressClick < 350) return;
      togglePlay();
    });
    v.addEventListener('dblclick', toggleFull);
    // 播放器自己报错（源坏了 / 格式不支持）→ 自动换源
    v.addEventListener('error', function () {
      if (!S.curEp || S.swapBusy) return;
      if ((v.currentTime || 0) < 1) autoSwap('这个源播放失败');
    });
    bindGestures();

    // 进度条拖动（鼠标 + 触屏通用）
    var bar = $('vBar');
    bar.addEventListener('pointerdown', function (e) {
      V.dragging = true;
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
      barSeek(e); syncBar(); showCtl();
      e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) {
      if (V.dragging) { barSeek(e); syncBar(); }
    });
    bar.addEventListener('pointerup', function () {
      if (!V.dragging) return;
      V.dragging = false;
      saveProgress();
      showCtl();
    });
    bar.addEventListener('pointercancel', function () { V.dragging = false; });

    ['timeupdate', 'progress', 'loadedmetadata', 'durationchange', 'seeked'].forEach(function (ev) {
      v.addEventListener(ev, syncBar);
    });
    v.addEventListener('play', syncPlayIcon);
    v.addEventListener('pause', syncPlayIcon);
    v.addEventListener('volumechange', syncMute);

    // 缓冲转圈：卡的时候用户能看出是在加载
    ['waiting', 'seeking'].forEach(function (ev) {
      v.addEventListener(ev, function () { $('vSpin').classList.add('show'); });
    });
    ['playing', 'canplay', 'seeked', 'error'].forEach(function (ev) {
      v.addEventListener(ev, function () { $('vSpin').classList.remove('show'); });
    });
    // 卡顿自动换源（见 stallStart / stallSwap）
    ['waiting', 'stalled'].forEach(function (ev) { v.addEventListener(ev, stallStart); });
    ['playing', 'canplay'].forEach(function (ev) { v.addEventListener(ev, stallEnd); });
    v.addEventListener('seeked', stallEnd);

    $('vCtl').addEventListener('click', function (e) {
      if (e.target === $('vCtl')) togglePlay();
    });

    var pl = $('player');
    pl.addEventListener('mousemove', showCtl);
    pl.addEventListener('touchstart', showCtl);
    pl.addEventListener('mouseleave', function () {
      if (!v.paused) $('player').classList.add('hide-ctl');
    });
  }

  // 起播时定位：续播优先，其次是自动跳过片头
  function applyStart() {
    var v = $('video');
    var t = S.seek || 0;
    if (!t && AUTO.on && S.skip && S.skip.intro > 0) t = S.skip.intro;
    S.seek = 0;
    if (t > 1 && isFinite(t)) {
      try { v.currentTime = t; } catch (e) {}
      setHow('已定位到 ' + fmtTime(t));
    }
  }

  function renderPlayerEps(d) {
    renderPlayerSrcs(d);
    // 选集面板要跟着「正在播的那条线路」走，而不是详情页当前选中的线路：
    // 续播 / 换源过来时 S.curGroup 可能还停在别的线路，用错就会显示错的集数列表。
    var gi = (S.curEp && S.curEp.d === d) ? S.curEp.gi : S.curGroup;
    var g = d.groups[gi];
    if (!g) { $('epBar').innerHTML = ''; return; }
    $('epBar').innerHTML = g.episodes.map(function (e, i) {
      return '<div class="ep ' + (S.curEp && S.curEp.ei === i ? 'playing' : '') +
        '" data-i="' + i + '">' + esc(e.name) + '</div>';
    }).join('');
    $('epBar').querySelectorAll('.ep').forEach(function (el) {
      el.onclick = function () { play(d, gi, parseInt(el.dataset.i, 10), 0); };
    });
  }

  /* ---------------- 进度：记录看到第几集、第几秒 ---------------- */

  function curRecord() {
    var ce = S.curEp, v = $('video');
    if (!ce) return null;
    var d = ce.d;
    var g = d.groups[ce.gi];
    var ep = g && g.episodes[ce.ei];
    var pos = v.currentTime || 0;
    if (!isFinite(pos) || pos < 0) pos = 0;
    var dur = v.duration;
    if (!isFinite(dur) || dur <= 0) dur = S.durKnown || 0;
    return {
      key: d.key, site: d.site, id: d.id, name: d.name, pic: d.pic,
      gi: ce.gi, ei: ce.ei, epName: (ep && ep.name) || '',
      pos: Math.round(pos * 10) / 10,
      dur: Math.round((dur || 0) * 10) / 10,
      intro: (S.skip && S.skip.intro) || 0,
      outro: (S.skip && S.skip.outro) || 0,
      time: Date.now()
    };
  }

  // 保存进度：本机 + 云端（登录时）
  function saveProgress() {
    var rec = curRecord();
    if (!rec || rec.pos < 1) return;
    if (!cloudReady()) return;      // 未登录不记录观看进度
    progSaveLocal(rec);
    if (cloudReady()) cloudProgUpsert(rec).catch(function () {});
  }

  // 关窗口 / 切集时用 sendBeacon 兜底，保证最后一次进度不丢
  function flushProgress(silent) {
    var rec = curRecord();
    if (!rec || rec.pos < 1) return;
    if (!cloudReady()) return;      // 未登录不落盘
    P.map[rec.key] = rec;
    if (isLocal()) {
      // 手机端独立运行：没有 /api/progress 这个地址，直接写本机
      api('/progress', null, rec);
    } else {
      try {
        navigator.sendBeacon('/api/progress',
          new Blob([JSON.stringify(rec)], { type: 'application/json' }));
      } catch (e) {
        api('/progress', null, rec);
      }
    }
    if (cloudReady()) cloudProgUpsert(rec).catch(function () {});
    if (!silent) toast('已保存观看进度');
  }

  function nextEp() {
    var ce = S.curEp;
    if (!ce) return;
    var d = ce.d;
    var g = d.groups[ce.gi];
    if (ce.ei + 1 < g.episodes.length) {
      play(d, ce.gi, ce.ei + 1, 0);
    } else if (ce.gi + 1 < d.groups.length) {
      S.curGroup = ce.gi + 1;
      play(d, ce.gi + 1, 0, 0);
    } else {
      toast('已经是最后一集了');
    }
  }

  // timeupdate：每 10 秒存一次；到达片尾自动跳下一集
  function onTimeUpdate() {
    syncBar();
    var v = $('video');
    if (!S.curEp || v.paused) return;
    var t = v.currentTime || 0;
    if (AUTO.on && S.skip && S.skip.outro > 5 && t >= S.skip.outro) {
      // 只有「后面还有集」才跳；最后一集如果也去调 nextEp，会每帧弹一次
      // 「已经是最后一集了」把提示刷爆。
      var g = S.curEp.d.groups[S.curEp.gi];
      var hasNext = (g && S.curEp.ei + 1 < g.episodes.length) ||
                    (S.curEp.gi + 1 < S.curEp.d.groups.length);
      if (hasNext) { toast('已跳过片尾'); nextEp(); return; }
    }
    var now = Date.now();
    if (now - P.lastPush > 10000) {
      P.lastPush = now;
      saveProgress();
    }
  }

  // 播放器顶栏按钮的状态与提示文字（下一集/选集标注/信息行/自动跳过）
  function updatePctl() {
    var bn = $('btnNextEp'), info = $('pInfo'), el = $('epLine');
    var has = !!(S.skip && S.skip.intro > 0);
    var hasO = !!(S.skip && S.skip.outro > 0);
    var ba = $('btnAutoSkip');
    if (ba) {
      ba.textContent = '自动跳过 ' + (AUTO.on ? '开' : '关');
      ba.classList.toggle('on', AUTO.on);
    }
    var txt = [];
    var g = S.curEp ? S.curEp.d.groups[S.curEp.gi] : null;
    if (S.curEp && g) {
      var ep = g.episodes[S.curEp.ei];
      if (ep) txt.push(ep.name);
      if (bn) bn.style.display = ((S.curEp.ei + 1 < g.episodes.length) ||
        (S.curEp.gi + 1 < S.curEp.d.groups.length)) ? '' : 'none';
      if (el) el.textContent = g.episodes.length + ' 集 · 当前 ' + (ep ? ep.name : (S.curEp.ei + 1));
    } else {
      if (bn) bn.style.display = 'none';
      if (el) el.textContent = '';
    }
    if (has) txt.push('片头 ' + fmtTime(S.skip.intro));
    if (hasO) txt.push('片尾 ' + fmtTime(S.skip.outro));
    info.textContent = txt.join(' · ');
  }

  function seekBy(sec) {
    var v = $('video');
    if (!v || !S.curEp) { toast('还没开始播放'); return; }
    var t = (v.currentTime || 0) + sec;
    var dur = isFinite(v.duration) && v.duration > 0 ? v.duration : S.durKnown;
    if (dur && t > dur - 1) t = Math.max(0, dur - 1);
    if (t < 0) t = 0;
    try { v.currentTime = t; } catch (e) {}
    saveProgress();
  }

  // 点「片头」：把当前时间记成片头结束点（以后这个剧自动从这里开始）
  function markIntro() {
    var v = $('video');
    if (!v || !S.curEp) { toast('还没开始播放'); return; }
    if (!S.skip) S.skip = { intro: 0, outro: 0 };
    var t = Math.round(v.currentTime || 0);
    if (S.skip.intro && Math.abs(S.skip.intro - t) < 3) {
      S.skip.intro = 0;
      toast('已取消片头跳过');
    } else {
      S.skip.intro = t;
      toast('已记下片头结束点 ' + fmtTime(t) + '，本剧下次自动跳过片头');
    }
    saveProgress();
    updatePctl();
  }

  // 点「片尾」：播到这里自动跳到下一集
  function markOutro() {
    var v = $('video');
    if (!v || !S.curEp) { toast('还没开始播放'); return; }
    if (!S.skip) S.skip = { intro: 0, outro: 0 };
    var t = Math.round(v.currentTime || 0);
    if (S.skip.outro && Math.abs(S.skip.outro - t) < 3) {
      S.skip.outro = 0;
      toast('已取消片尾跳过');
    } else {
      S.skip.outro = t;
      toast('已记下片尾开始点 ' + fmtTime(t) + '，播到这里自动跳下一集');
    }
    saveProgress();
    updatePctl();
  }

  function showPlayer(title, how) {
    $('playerTitle').textContent = title;
    setHow(how || '');
    $('player').classList.add('show');
    showCtl();
    syncPlayIcon();
    syncBar();
  }
  function setHow(t) { $('playerHow').textContent = t || ''; }

  function closePlayer() {
    var v = $('video');
    try { v.pause(); } catch (e) {}
    if (S.curEp) flushProgress(true);
    S.curEp = null;
    S.playSrc = ''; S.playReal = '';
    $('speedPop').classList.remove('show');
    v.removeAttribute('src');
    try { v.load(); } catch (e) {}
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    clearTimeout(V.timer);
    $('vSpin').classList.remove('show');
    $('player').classList.remove('hide-ctl');
    if (FS_ON) applyFs(false);
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    $('player').classList.remove('ep-open');
    $('morePop').classList.remove('show');
    $('btnMore').classList.remove('open');
    $('player').classList.remove('show');
    syncBar();
    // 关掉播放器后，首页「继续观看」和详情页的进度文案要跟着变，
    // 否则会一直停在播放前的样子（时间、集数、排序都不对）
    renderResume();
    var act = document.querySelector('.page.active');
    if (act && act.id === 'page-detail' && S.detail) refreshResume(S.detail);
  }

  /* ------------------------------------------------ 自定义地址 / 直播 */

  function playCustom() {
    var u = $('customUrl').value.trim();
    if (!u) { toast('请填写播放地址'); return; }
    if (/^[a-zA-Z]:\\/.test(u)) u = 'file:///' + u.replace(/\\/g, '/');
    if (S.curEp) flushProgress(true);
    S.curEp = null; S.skip = null; S.seek = 0;
    showPlayer('自定义地址', '');
    api('/custom', { url: u }).then(function (r) {
      if (!r.ok) { toast(r.error || '无法播放'); return; }
      var v = $('video');
      if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
      if (/\.m3u8|mpegurl/i.test(r.url) && window.Hls && window.Hls.isSupported()) {
        S.hls = new window.Hls(hlsConfig());
        S.hls.loadSource(abs(r.play));
        S.hls.attachMedia(v);
      } else {
        v.src = abs(r.play);
      }
      tryPlay(v);
      $('epBar').innerHTML = '';
      updatePctl();
    });
  }

  function loadLive() {
    var u = $('liveUrl').value.trim();
    if (!u) { toast('请填写直播列表地址'); return; }
    var box = $('liveGroups');
    box.innerHTML = '<div class="loading">正在加载频道…</div>';
    api('/live', { url: u }).then(function (r) {
      if (!r.ok) { box.innerHTML = '<div class="empty">' + esc(r.error || '加载失败') + '</div>'; return; }
      if (!r.list.length) { box.innerHTML = '<div class="empty">没有解析到频道</div>'; return; }
      var groups = {};
      r.list.forEach(function (c) {
        var g = c.group || '默认分组';
        (groups[g] = groups[g] || []).push(c);
      });
      var html = '';
      Object.keys(groups).forEach(function (g) {
        html += '<div class="live-grp"><h4>' + esc(g) + '（' + groups[g].length + '）</h4>' +
          '<div class="live-chans">' + groups[g].map(function (c) {
            return '<div class="chan" data-u="' + esc(c.url) + '" data-n="' + esc(c.name) + '">' +
              esc(c.name) + '</div>';
          }).join('') + '</div></div>';
      });
      box.innerHTML = html;
      box.querySelectorAll('.chan').forEach(function (el) {
        el.onclick = function () { playLive(el.dataset.u, el.dataset.n); };
      });
    });
  }

  function playLive(u, name) {
    if (S.curEp) flushProgress(true);
    S.curEp = null; S.skip = null; S.seek = 0;
    showPlayer('直播 · ' + name, '直播流');
    updatePctl();
    var v = $('video');
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    // 手机端本地模式没有服务端代理，直播流直接连；连电脑时才走电脑反代
    var play = isLocal() ? u : abs('/proxy?url=' + encodeURIComponent(u));
    if (/\.m3u8/i.test(u) && window.Hls && window.Hls.isSupported()) {
      S.hls = new window.Hls(hlsConfig({
        liveSyncDurationCount: 3, maxBufferLength: 20, backBufferLength: 15
      }));
      S.hls.loadSource(play);
      S.hls.attachMedia(v);
    } else {
      v.src = play;
    }
    tryPlay(v);
    $('epBar').innerHTML = '';
  }

  /* ------------------------------------------------ 收藏 / 历史 */

  function loadFavs() {
    if (!cloudReady()) {
      // 未登录：收藏是本机 / 账号数据都不加载，页面给一句引导
      $('favBox').innerHTML = '<div class="empty">登录后才能使用收藏<br>点右上角「我的」登录或注册账号</div>';
      $('favCount').textContent = '';
      return Promise.resolve();
    }
    return api('/state').then(function (r) {
      S.favs = (r.ok && r.favorites) || [];
      S.favKeys = {};
      S.favs.forEach(function (f) { if (f.key) S.favKeys[f.key] = 1; });
      if (r.ok && r.progress) P.map = r.progress;
      renderFavs();
    });
  }

  function renderFavs() {
    $('favCount').textContent = S.favs.length ? (S.favs.length + ' 部') : '';
    $('btnFavManage').textContent = S.mgrFav ? '完成' : '编辑';
    $('btnFavManage').classList.toggle('on', S.mgrFav);
    $('btnFavClear').style.display = S.mgrFav ? 'none' : '';
    var box = $('favBox');
    box.classList.toggle('mgr-mode', S.mgrFav);
    renderFavBar();
    if (!S.favs.length) {
      box.innerHTML = '<div class="empty">还没有收藏内容<br>在影片详情页点「☆ 收藏」即可加入这里</div>';
      return;
    }
    box.innerHTML = '<div class="grid">' +
      S.favs.map(function (v) { return cardHtml(v, v.site, true, { ck: true }); }).join('') + '</div>';
    box.querySelectorAll('.card').forEach(function (el, i) {
      var v = S.favs[i];
      if (S.selFav[v.key]) el.classList.add('sel');
      el.onclick = function (ev) {
        if (ev.target.classList.contains('xdel')) return;
        if (S.mgrFav) { toggleSel(S.selFav, v.key, el); renderFavBar(); return; }
        openDetail(el.dataset.id, el.dataset.site);
      };
    });
    box.querySelectorAll('.xdel').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var key = el.dataset.del;
        api('/favorite', null, { video: { key: key } }).then(function () {
          toast('已取消收藏');
          if (cloudReady()) cloudFavDelete(key).catch(function () {});
          loadFavs();
        });
      };
    });
  }

  function toggleSel(map, key, el) {
    if (map[key]) { delete map[key]; el.classList.remove('sel'); }
    else { map[key] = 1; el.classList.add('sel'); }
  }

  function renderFavBar() {
    var bar = $('favBar');
    bar.classList.toggle('show', S.mgrFav);
    if (!S.mgrFav) { bar.innerHTML = ''; return; }
    bar.innerHTML = '<span>已选 <b>' + Object.keys(S.selFav).length + '</b> 部</span>' +
      '<div class="mgrow">' +
      '<button id="fvAll">全选</button>' +
      '<button id="fvNone">取消全选</button>' +
      '<button class="danger" id="fvDel">删除选中</button></div>';
    $('fvAll').onclick = function () {
      S.favs.forEach(function (v) { S.selFav[v.key] = 1; });
      renderFavs();
    };
    $('fvNone').onclick = function () { S.selFav = {}; renderFavs(); };
    $('fvDel').onclick = function () {
      var keys = Object.keys(S.selFav);
      if (!keys.length) { toast('还没选中任何一部'); return; }
      if (!confirm('确定删除选中的 ' + keys.length + ' 部收藏？')) return;
      api('/favorite', null, { action: 'remove', keys: keys }).then(function () {
        if (cloudReady()) keys.forEach(function (k) { cloudFavDelete(k).catch(function () {}); });
        toast('已删除 ' + keys.length + ' 部');
        S.selFav = {}; S.mgrFav = false;
        loadFavs();
      });
    };
  }

  function toggleFav(d, btn) {
    if (!cloudReady()) { toast('请先登录后再收藏', 3000); return; }
    api('/favorite', null, {
      video: { key: d.key, site: d.site, id: d.id, name: d.name, pic: d.pic }
    }).then(function (r) {
      if (!r.ok) { toast(r.error || '操作失败'); return; }
      if (r.added) S.favKeys[d.key] = 1; else delete S.favKeys[d.key];
      if (btn) btn.textContent = r.added ? '★ 已收藏' : '☆ 收藏';
      toast(r.added ? '已加入收藏' : '已取消收藏');
      if (cloudReady()) {
        var job = r.added
          ? cloudFavUpsert({ key: d.key, site: d.site, id: d.id, name: d.name, pic: d.pic })
          : cloudFavDelete(d.key);
        job.catch(function (e) { toast('云端同步失败：' + e.message, 3600); });
      }
    });
  }

  function saveHistory(d) {
    if (!cloudReady()) return;      // 未登录不记录观看历史
    api('/history', null, {
      video: { key: d.key, site: d.site, id: d.id, name: d.name, pic: d.pic, time: Date.now() }
    });
  }

  function loadHistory() {
    if (!cloudReady()) {
      $('historyBox').innerHTML = '<div class="empty">登录后才能使用观看历史<br>点右上角「我的」登录或注册账号</div>';
      return;
    }
    api('/history').then(function (r) {
      var list = (r.ok && r.list) || [];
      S.hisList = list;
      var box = $('historyBox');
      $('btnHisManage').textContent = S.mgrHis ? '完成' : '编辑';
      $('btnHisManage').classList.toggle('on', S.mgrHis);
      $('btnHisClear').style.display = S.mgrHis ? 'none' : '';
      box.classList.toggle('mgr-mode', S.mgrHis);
      renderHisBar();
      if (!list.length) {
        box.innerHTML = '<div class="empty">还没有观看记录</div>';
        return;
      }
      box.innerHTML = '<div class="grid">' +
        list.map(function (v) {
          var rec = P.map[v.key];
          if (!(rec && rec.pos > 5)) return cardHtml(v, v.site, false, { ck: true });
          var line = (rec.epName || ('第' + ((rec.ei || 0) + 1) + '集')) +
            ' · 看到 ' + fmtTime(rec.pos) + (rec.dur ? ' / ' + fmtTime(rec.dur) : '');
          return '<div class="card-wrap">' + cardHtml(v, v.site, false, { ck: true }) +
            '<div class="prog-line">' + esc(line) + '</div></div>';
        }).join('') + '</div>';
      box.querySelectorAll('.card').forEach(function (el, i) {
        var v = list[i];
        if (S.selHis[v.key]) el.classList.add('sel');
        el.onclick = function () {
          if (S.mgrHis) { toggleSel(S.selHis, v.key, el); renderHisBar(); return; }
          openDetail(el.dataset.id, el.dataset.site, true);
        };
      });
    });
  }

  function renderHisBar() {
    var bar = $('hisBar');
    bar.classList.toggle('show', S.mgrHis);
    if (!S.mgrHis) { bar.innerHTML = ''; return; }
    bar.innerHTML = '<span>已选 <b>' + Object.keys(S.selHis).length + '</b> 条</span>' +
      '<div class="mgrow">' +
      '<button id="hvAll">全选</button>' +
      '<button id="hvNone">取消全选</button>' +
      '<button class="danger" id="hvDel">删除选中</button></div>';
    $('hvAll').onclick = function () {
      (S.hisList || []).forEach(function (v) { S.selHis[v.key] = 1; });
      loadHistory();
    };
    $('hvNone').onclick = function () { S.selHis = {}; loadHistory(); };
    $('hvDel').onclick = function () {
      var keys = Object.keys(S.selHis);
      if (!keys.length) { toast('还没选中任何一条'); return; }
      if (!confirm('确定删除选中的 ' + keys.length + ' 条记录？')) return;
      api('/history', null, { action: 'remove', keys: keys }).then(function () {
        toast('已删除 ' + keys.length + ' 条');
        S.selHis = {}; S.mgrHis = false;
        loadHistory();
      });
    };
  }

  /* ------------------------------------------------ 我的（账号 / 设置 / 投屏 / 下载） */

  function renderMine() {
    updateUserBtn();
    renderServerPanel();

    var a = $('setAutoSkip'); if (a) a.checked = AUTO.on;
    var r = $('setRate'); if (r) r.value = V.speed;
    var rv = $('setRateVal'); if (rv) rv.textContent = speedLabel(V.speed);
    var g = $('setGesture'); if (g) g.checked = GEST.on;

    var ms = $('mineSync');
    if (ms) {
      ms.classList.add('show');
      if (!(window.Cloud && window.Cloud.enabled())) {
        ms.innerHTML = '<i class="dot warn"></i>还没配置云端，收藏和进度只存在这一台设备上';
      } else if (cloudReady()) {
        ms.innerHTML = '<i class="dot ok"></i>云端同步已开启（收藏 / 自定义影视源 / 观看进度）';
      } else {
        ms.innerHTML = '<i class="dot warn"></i>未登录：收藏和观看进度只存在这一台设备上';
      }
    }
    renderDlBox();
    renderCacheTip();
  }

  /* ---- 手机 / 平板连接电脑（可选增强）
     手机版自己能直接连影视源看片，所以「连电脑」不再是必需步骤：
     连上以后多出「投屏到电视 / 播放电脑上的本地文件」等能力。 */
  function renderServerPanel() {
    var d = $('srvDesk'), a = $('srvApp');
    if (d) d.style.display = NATIVE ? 'none' : '';
    if (a) a.style.display = NATIVE ? '' : 'none';
    if (NATIVE) {
      var u = $('srvUrl');
      if (u && document.activeElement !== u) u.value = SERVER || '';
      var m = $('srvMsg');
      if (m && !m.textContent) {
        m.textContent = SERVER ? ('当前已连接：' + SERVER) : '当前独立运行（不连电脑也能正常看片）';
      }
      var cb = $('btnSrvClear');
      if (cb) cb.style.display = SERVER ? '' : 'none';
      return;
    }
    var s = $('srvShow');
    if (!s) return;
    if (s.value) return;
    api('/lanip').then(function (r) {
      if (r && r.ok) s.value = 'http://' + r.ip + ':' + r.port;
    });
  }

  // 手机端：断开 / 清除电脑地址，回到独立运行
  function clearServer() {
    setServer('');
    var m = $('srvMsg');
    if (m) m.textContent = '已断开，当前独立运行（不连电脑也能正常看片）';
    S.site = null; S.sites = []; S.feedCats = []; S.cands = {};
    toast('已断开电脑连接，手机将独立运行');
    renderServerPanel();
    loadSites();
  }

  // 手机端：保存地址并试连，通了就重新拉数据
  function saveServer(v) {
    setServer(v);
    var m = $('srvMsg') || $('setupMsg');
    if (m) m.textContent = '正在连接…';
    return api('/health').then(function (r) {
      if (r && r.ok) {
        if (m) m.textContent = '连接成功';
        var sm = $('setupModal'); if (sm) sm.classList.remove('show');
        toast('已连接到电脑，正在加载影视源…');
        S.site = null; S.sites = []; S.feedCats = []; S.cands = {};
        loadSites();
        updateUserBtn();
        return true;
      }
      if (m) m.textContent = '连不上：请确认电脑上的独享库正在运行，且手机和电脑在同一个 WiFi';
      return false;
    });
  }

  // 首次打开不再强制填电脑地址：内置源直接用，连电脑改成「我的」页里的可选操作
  function needSetup() {
    return false;
  }

  /* ---- 离线下载 ---- */

  var DLT = { timer: 0 };
  var DLG = { open: {} };       // 哪几部剧在「离线下载」里展开了

  function dlSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function dlEpRow(it) {
    var st = it.state || '';
    var sub = st;
    if (st === '下载中') sub = it.total ? ('下载中 ' + it.done + ' / ' + it.total + ' 片') : ('下载中 ' + dlSize(it.size));
    else if (st === '排队中') sub = '排队中' + (it.queuePos ? '（第 ' + it.queuePos + ' 个）' : '');
    else if (st === '已完成' || st === '已中断') sub += ' · ' + dlSize(it.size);
    else if (st === '失败') sub += ' · ' + dlSize(it.size);
    if (it.error) sub += ' · ' + it.error;
    return '<div class="dl-ep">' +
      '<span class="de-n">' + esc(it.name || '未命名') + '</span>' +
      '<span class="de-s">' + esc(sub) + '</span>' +
      '<span class="de-o">' +
      (it.exists ? '<button data-act="play" data-id="' + esc(it.id) + '">播放</button>' : '') +
      (st === '失败' || st === '已中断' ? '<button data-act="retry" data-id="' + esc(it.id) + '">继续</button>' : '') +
      '<button data-act="del" data-id="' + esc(it.id) + '">删除</button>' +
      '</span></div>';
  }

  function renderDlBox() {
    var box = $('dlBox');
    if (!box) return;
    api('/dl/list').then(function (r) {
      var list = (r.ok && r.list) || [];
      clearTimeout(DLT.timer);
      if (!list.length) {
        box.innerHTML = '<div class="empty">还没有缓存任务<br>在详情页点「缓存」，勾选要存的集数就能存到本机</div>';
        return;
      }
      var bytes = list.reduce(function (a, x) { return a + (Number(x.size) || 0); }, 0);
      // 同一部剧折成一行（手机端 / 电脑端通用）
      var groups = [], byG = {};
      list.forEach(function (it) {
        var g = it.group || ('solo:' + it.id);
        if (!byG[g]) { byG[g] = { id: g, name: it.drama || it.name, items: [] }; groups.push(byG[g]); }
        byG[g].items.push(it);
      });
      box.innerHTML = '<div class="dl-total">已占用本机空间：<b>' + dlSize(bytes) + '</b></div>' +
        groups.map(function (gr) {
          var items = gr.items, total = items.length;
          var doneN = items.filter(function (x) { return x.state === '已完成'; }).length;
          var run = items.filter(function (x) { return x.state === '下载中'; }).length;
          var wait = items.filter(function (x) { return x.state === '排队中'; }).length;
          var bad = items.filter(function (x) { return x.state === '失败' || x.state === '已中断'; }).length;
          var pct = total ? Math.round(doneN / total * 100) : 0;
          var sub;
          if (run) sub = '缓存中 ' + doneN + ' / ' + total + ' 集';
          else if (wait) sub = '排队中 ' + doneN + ' / ' + total + ' 集';
          else if (doneN >= total) sub = '已完成 · ' + dlSize(items.reduce(function (a, x) { return a + (Number(x.size) || 0); }, 0));
          else sub = '已缓存 ' + doneN + ' / ' + total + ' 集';
          if (bad) sub += ' · ' + bad + ' 集没下完';
          var cls = (doneN >= total) ? 'ok' : (bad && !run && !wait ? 'err' : '');
          var gid = gr.id;
          var open = !!DLG.open[gid];
          return '<div class="dl-item">' +
            '<div class="dt"><b>' + esc(gr.name || '未命名') + '</b><span>' + esc(sub) + '</span></div>' +
            '<div class="dlp"><i class="' + cls + '" style="width:' + pct + '%"></i></div>' +
            '<div class="dops">' +
            (total > 1 ? '<button data-act="fold" data-g="' + esc(gid) + '">' + (open ? '收起分集' : '展开分集') + '</button>' : '') +
            (bad ? '<button data-act="retry" data-g="' + esc(gid) + '">继续未完成</button>' : '') +
            '<button data-act="delall" data-g="' + esc(gid) + '">删除整部</button>' +
            '</div>' +
            (open ? '<div class="dl-eps">' + items.map(dlEpRow).join('') + '</div>' : '') +
            '</div>';
        }).join('');

      box.onclick = function (e) {
        var b = e.target.closest ? e.target.closest('button') : null;
        if (!b) return;
        var act = b.dataset.act, gid = b.dataset.g || '';
        if (act === 'fold') {
          DLG.open[gid] = !DLG.open[gid];
          renderDlBox();
        } else if (act === 'delall') {
          if (!confirm('删除这部剧已缓存的全部文件？')) return;
          api('/dl/remove', null, { group: gid }).then(function () {
            toast('已删除整部');
            DLG.open[gid] = false;
            renderDlBox();
          });
        } else if (act === 'retry') {
          var ids = gid
            ? list.filter(function (x) {
                return x.group === gid && (x.state === '失败' || x.state === '已中断');
              }).map(function (x) { return x.id; })
            : [b.dataset.id];
          if (!ids.length) { toast('这部剧没有没下完的集'); return; }
          // 一集一集接着下（后端会按剩余字节 / 分片续传）
          ids.reduce(function (p, id) {
            return p.then(function () { return api('/dl/resume', null, { id: id }); });
          }, Promise.resolve()).then(function () {
            toast('已继续 ' + ids.length + ' 集');
            renderDlBox();
          });
        } else if (act === 'del') {
          if (!confirm('删除这一集？已下到本机的文件会一起删掉。')) return;
          api('/dl/remove', null, { id: b.dataset.id }).then(function () { toast('已删除'); renderDlBox(); });
        } else if (act === 'play') {
          var one = list.filter(function (x) { return x.id === b.dataset.id; })[0];
          if (one) playLocal(one.path, one.name);
        }
      };
      // 还有任务在跑就继续刷新进度
      if (list.some(function (x) { return x.state === '下载中' || x.state === '排队中'; })) {
        DLT.timer = setTimeout(renderDlBox, 1500);
      }
    });
  }

  /* 「我的 → 本机缓存」：把缓存用量显示出来

     原来这个面板只有一个按钮，用户点进去看不出到底存了多少东西、
     清空有没有生效，所以这里补一行「已缓存 X 份片单 · Y 张封面」。 */
  function renderCacheTip() {
    var el = $('cacheTip');
    if (!el) return;
    if (!CACHE) { el.textContent = '这台设备不支持本机缓存'; return; }
    CACHE.stats().then(function (s) {
      if (!s || (s.feed <= 0 && s.img <= 0 && !s.cats)) {
        el.textContent = '本机还没有缓存内容';
        return;
      }
      var parts = [];
      parts.push(s.feed + ' 份片单');
      if (s.cats) parts.push('1 份分类');
      if (s.img) parts.push(s.img + ' 张封面');
      el.textContent = '已缓存 ' + parts.join(' · ');
    }).catch(function () {});
  }

  function playLocal(fp, name) {
    if (!fp) return;
    if (S.curEp) flushProgress(true);
    S.curEp = null; S.skip = null; S.seek = 0;
    S.playReal = ''; S.playSrc = '';
    showPlayer(name || '本机文件', '本机文件');
    api('/custom', { url: fp }).then(function (r) {
      if (!r.ok) { toast(r.error || '无法播放这个文件'); return; }
      S.playSrc = r.play || '';
      var v = $('video');
      if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
      v.onloadedmetadata = function () { tryPlay(v); };
      v.src = abs(r.play);
      tryPlay(v);
      setHow(r.how || '本机文件');
    });
  }

  function dlCurrent() {
    var ce = S.curEp;
    if (!ce) { toast('请先打开一集，再点下载'); return; }
    var d = ce.d, g = d.groups[ce.gi], ep = g && g.episodes[ce.ei];
    var url = S.playReal || '';
    if (!url) { toast('这一集的地址还没解析好，等几秒再点'); return; }
    var name = d.name + (ep ? ' · ' + ep.name : '');
    toast('正在加入缓存…', 1600);
    api('/dl/start', null, {
      url: url, name: name, epName: ep ? ep.name : '',
      groupName: d.name, groupKey: d.key, ref: ''
    }).then(function (r) {
      if (!r.ok) { toast(r.error || '下载失败'); return; }
      toast('已开始下载，到「我的 → 离线下载」可以看进度', 3600);
    });
  }

  /* ---- 投屏（DLNA）：搜到电视后，把当前这一集推过去 ---- */

  function castUrl(rel) {
    if (!rel) return Promise.resolve('');
    if (/^https?:/i.test(rel)) return Promise.resolve(rel);
    // 电视要自己来取流，必须用局域网 IP，不能用 127.0.0.1
    return api('/lanip').then(function (r) {
      if (!r.ok) return '';
      return 'http://' + r.ip + ':' + r.port + (rel.charAt(0) === '/' ? rel : '/' + rel);
    });
  }

  function castScan(showPick) {
    var tip = $('castTip');
    // 手机端独立运行：投屏要电脑端转发，给个说明别报错
    if (isLocal()) {
      var nothingLocal = '投屏需要电脑端：连上电脑后再试（「我的 → 手机 / 平板连接」）';
      if (tip) tip.textContent = nothingLocal;
      if (showPick) {
        $('pickTitle').textContent = '投屏到电视';
        $('pickTip').textContent = nothingLocal;
        $('pickBox').innerHTML = '';
        $('pickModal').classList.add('show');
      }
      var cb0 = $('castBox');
      if (cb0) cb0.innerHTML = '';
      return;
    }
    if (showPick) {
      $('pickTitle').textContent = '投屏到电视';
      $('pickTip').textContent = '正在搜索局域网里的电视 / 盒子，大约 3 秒…';
      $('pickBox').innerHTML = '';
      $('pickModal').classList.add('show');
    } else if (tip) {
      tip.textContent = '正在搜索（约 3 秒）…';
    }
    api('/cast/scan', { timeout: 4 }).then(function (r) {
      var list = (r.ok && r.list) || [];
      var nothing = '没找到可投屏的设备，请确认电视 / 盒子已开机，且与本机在同一个 WiFi';
      if (tip) tip.textContent = list.length ? ('找到 ' + list.length + ' 台设备') : nothing;

      if (showPick) {
        if (!list.length) { $('pickTip').textContent = nothing; return; }
        $('pickTip').textContent = '点一台设备，把「' +
          (S.curEp ? S.curEp.d.name : '当前内容') + '」推过去播放。';
        $('pickBox').innerHTML = list.map(function (dev, i) {
          return '<div class="sp" data-i="' + i + '"><div><b>' + esc(dev.name) + '</b></div>' +
            '<span>' + esc(dev.ip) + '</span></div>';
        }).join('');
        $('pickBox').querySelectorAll('.sp').forEach(function (el) {
          el.onclick = function () {
            closePick();
            castTo(list[parseInt(el.dataset.i, 10)]);
          };
        });
        return;
      }

      var box = $('castBox');
      if (!box) return;
      if (!list.length) { box.innerHTML = ''; return; }
      box.innerHTML = list.map(function (dev, i) {
        return '<div class="cast-item"><div class="ct-t"><b>' + esc(dev.name) + '</b>' +
          '<span>' + esc(dev.ip) + '</span></div>' +
          '<button data-i="' + i + '">投屏</button></div>';
      }).join('');
      box.querySelectorAll('button').forEach(function (b) {
        b.onclick = function () { castTo(list[parseInt(b.dataset.i, 10)]); };
      });
    });
  }

  function castTo(dev) {
    var rel = S.playSrc || '';
    if (!rel) { toast('还没有正在播放的内容：先打开一集，再点投屏'); return; }
    var name = '独享库';
    if (S.curEp) {
      var g = S.curEp.d.groups[S.curEp.gi] || { episodes: [] };
      var ep = g.episodes[S.curEp.ei] || {};
      name = S.curEp.d.name + (ep.name ? ' · ' + ep.name : '');
    }
    castUrl(rel).then(function (abs) {
      if (!abs) { toast('取不到本机局域网地址，请检查网络连接'); return; }
      toast('正在推送到「' + dev.name + '」…', 3000);
      api('/cast/play', null, { control: dev.control, url: abs, name: name }).then(function (r) {
        toast(r.ok ? ('已推送到「' + dev.name + '」，电视上应该开始播放了')
                   : ('投屏失败：' + (r.error || '未知原因')), 4200);
      });
    });
  }

  /* ------------------------------------------------ 设置 / 源管理 */

  function openSet() {
    $('modal').classList.add('show');
    loadSrcState();
  }
  function closeSet() { $('modal').classList.remove('show'); }

  function loadSrcState() {
    api('/state').then(function (r) {
      if (!r.ok) return;

      var presets = r.presets || [];
      $('presetBox').innerHTML = presets.length ? presets.map(function (p, i) {
        return '<div class="preset"><div><div class="pname">' + esc(p.name) + '</div>' +
          '<div class="purl">' + esc(p.url) + '</div></div>' +
          '<button data-i="' + i + '">测试并添加</button></div>';
      }).join('') : '<div class="empty">暂无推荐源</div>';
      $('presetBox').querySelectorAll('button').forEach(function (b) {
        b.onclick = function () {
          var p = presets[parseInt(b.dataset.i, 10)];
          $('newSrcName').value = p.name;
          $('newSrcUrl').value = p.url;
          addSrc();
        };
      });

      var srcs = r.sources || [];
      $('srcBox').innerHTML = srcs.length ? srcs.map(function (s) {
        return '<div class="src ' + (s.enabled ? '' : 'off') + '">' +
          '<div class="sinfo"><div class="sname">' + esc(s.name) + '</div>' +
          '<div class="smeta">' + esc(s.url) + '<br>站点 ' + s.siteCount +
          ' 个 · 解析接口 ' + s.parseCount + ' 个</div></div>' +
          '<div class="sops">' +
          '<button data-act="toggle" data-id="' + esc(s.id) + '">' + (s.enabled ? '停用' : '启用') + '</button>' +
          '<button data-act="refresh" data-id="' + esc(s.id) + '">更新</button>' +
          '<button data-act="remove" data-id="' + esc(s.id) + '">删除</button>' +
          '</div></div>';
      }).join('') : '<div class="empty">还没有添加任何源</div>';

      $('srcBox').querySelectorAll('button').forEach(function (b) {
        b.onclick = function () {
          var act = b.dataset.act, id = b.dataset.id;
          if (act === 'remove' && !confirm('确定删除这个源？')) return;
          api('/source/' + act, null, { id: id }).then(function (res) {
            if (!res.ok) { toast(res.error || '操作失败'); return; }
            if (act === 'refresh' && res.removed && res.removed.length) {
              toast('已剔除失效站点 ' + res.removed.length + ' 个');
            } else {
              toast(act === 'toggle' ? '已切换状态' : act === 'refresh' ? '已更新' : '已删除');
            }
            S.feedCats = []; S.cands = {};
            loadSrcState();
            loadSites();

            // 登录状态下，把源的变化同步到云端
            if (cloudReady() && act !== 'refresh') {
              if (act === 'remove') {
                cloudSrcDelete(id).catch(function () {});
              } else {
                api('/state').then(function (st) {
                  var s = (st.sources || []).filter(function (x) { return x.id === id; })[0];
                  if (s && !s.builtin) cloudSrcUpsert(s).catch(function () {});
                });
              }
            }
          });
        };
      });
    });
  }

  function testSrc() {
    var url = $('newSrcUrl').value.trim();
    if (!url) { toast('请填写接口地址'); return; }
    var m = $('srcMsg');
    m.className = 'msg';
    m.textContent = '正在测试…';
    api('/source/test', null, { url: url }).then(function (r) {
      if (r.ok) {
        m.className = 'msg ok';
        m.textContent = '测试成功：发现 ' + r.siteCount + ' 个站点、' + r.parseCount +
          ' 个解析接口。示例：' + (r.samples || []).slice(0, 6).join('、');
      } else {
        m.className = 'msg err';
        m.textContent = '失败：' + (r.error || '无法访问该地址');
      }
    });
  }

  function addSrc() {
    var url = $('newSrcUrl').value.trim();
    var name = $('newSrcName').value.trim();
    if (!url) { toast('请填写接口地址'); return; }
    var m = $('srcMsg');
    m.className = 'msg';
    m.textContent = '正在订阅并解析站点…';
    api('/source/add', null, { url: url, name: name }).then(function (r) {
      if (!r.ok) {
        m.className = 'msg err';
        m.textContent = '失败：' + (r.error || '添加失败');
        return;
      }
      m.className = 'msg ok';
      m.textContent = '添加成功，共 ' + r.siteCount + ' 个站点';
      $('newSrcUrl').value = '';
      $('newSrcName').value = '';
      S.feedCats = []; S.cands = {};
      loadSrcState();
      loadSites();
      if (cloudReady() && r.id) {
        cloudSrcUpsert({ id: r.id, name: name, url: url, enabled: true }).catch(function () {});
      }
    });
  }

  /* ------------------------------------------------ 事件绑定 */

  $('brandBtn').onclick = function () { go('home'); };
  $('btnSearch').onclick = function () { doSearch(); };
  $('kw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  // 搜索框下拉：历史 + 热词
  $('kw').addEventListener('focus', function () { renderSearchDrop(); });
  $('kw').addEventListener('click', function () { renderSearchDrop(); });
  document.addEventListener('click', function (e) {
    if (!$('searchDrop').contains(e.target) && e.target !== $('kw')) hideSearchDrop();
  });
  // 聚合 / 分源视图切换
  $('searchSeg').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () {
      S.search.view = b.dataset.v;
      $('searchSeg').querySelectorAll('button').forEach(function (x) {
        x.classList.toggle('on', x === b);
      });
      renderSearch();
    };
  });
  $('btnPickClose').onclick = closePick;
  $('pickModal').addEventListener('click', function (e) {
    if (e.target === $('pickModal')) closePick();
  });
  // 收藏 / 历史：管理、清空
  $('btnFavManage').onclick = function () {
    S.mgrFav = !S.mgrFav; S.selFav = {}; renderFavs();
  };
  $('btnFavClear').onclick = function () {
    if (!S.favs.length) { toast('收藏本来是空的'); return; }
    if (!confirm('确定清空全部收藏？此操作不可撤销。')) return;
    api('/favorite', null, { action: 'clear' }).then(function () {
      if (cloudReady()) {
        S.favs.forEach(function (v) { cloudFavDelete(v.key).catch(function () {}); });
      }
      toast('已清空收藏');
      S.selFav = {}; S.mgrFav = false;
      loadFavs();
    });
  };
  $('btnHisManage').onclick = function () {
    S.mgrHis = !S.mgrHis; S.selHis = {}; loadHistory();
  };
  $('btnHisClear').onclick = function () {
    if (!confirm('确定清空全部观看历史？此操作不可撤销。')) return;
    api('/history', null, { action: 'clear' }).then(function () {
      toast('已清空观看历史');
      S.selHis = {}; S.mgrHis = false;
      loadHistory();
    });
  };
  $('btnSet').onclick = openSet;
  $('btnSetClose').onclick = closeSet;
  $('btnCustomPlay').onclick = playCustom;
  $('btnLiveLoad').onclick = loadLive;
  $('btnSrcTest').onclick = testSrc;
  $('btnSrcAdd').onclick = addSrc;
  $('btnPlayerClose').onclick = closePlayer;
  $('btnPlayerBack').onclick = closePlayer;

  // 播放器控制条
  initPlayerUI();
  $('btnBack90').onclick = function () { seekBy(-90); };
  $('btnFwd90').onclick = function () { seekBy(90); };
  $('btnIntro').onclick = markIntro;
  $('btnOutro').onclick = markOutro;
  $('btnAutoSkip').onclick = toggleAutoSkip;
  $('btnSwap').onclick = manualSwap;
  $('btnNextEp').onclick = nextEp;

  // 顶栏：选集折叠 / 更多面板
  function setEpOpen(on) {
    $('player').classList.toggle('ep-open', on);
    $('btnEpToggle').classList.toggle('open', on);
  }
  $('btnEpToggle').onclick = function () {
    setEpOpen(!$('player').classList.contains('ep-open'));
  };
  $('btnEpClose').onclick = function () { setEpOpen(false); };
  $('btnMore').onclick = function (e) {
    e.stopPropagation();
    $('morePop').classList.toggle('show');
    $('btnMore').classList.toggle('open');
  };
  document.addEventListener('click', function (e) {
    var m = $('morePop'), b = $('btnMore');
    if (m && m.classList.contains('show') &&
        !e.target.closest('#morePop') && !e.target.closest('#btnMore')) {
      m.classList.remove('show');
      if (b) b.classList.remove('open');
    }
  });
  $('video').addEventListener('timeupdate', onTimeUpdate);
  $('video').addEventListener('pause', function () { if (S.curEp) saveProgress(); });
  $('video').addEventListener('ended', function () {
    if (!S.curEp) return;
    if (S.skip && S.skip.outro > 5) return;   // 片尾已设过，交给 timeupdate 处理
    nextEp();
  });
  window.addEventListener('beforeunload', function () {
    if (S.curEp) flushProgress(true);
  });

  // 登录相关
  $('btnUser').onclick = openAuth;
  $('btnAuthClose').onclick = closeAuth;
  $('btnDoLogin').onclick = doLogin;
  $('btnDoSignup').onclick = doSignup;
  $('btnDoLogout').onclick = doLogout;
  $('authModal').addEventListener('click', function (e) {
    if (e.target === $('authModal')) closeAuth();
  });
  $('authPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  // 「我的」页：账号 / 播放设置 / 投屏 / 下载
  $('mcLogin').onclick = function () { if (cloudReady()) doLogout(); else openAuth(); };
  $('btnOpenSet').onclick = openSet;
  $('btnCastScan').onclick = function () { castScan(false); };
  $('setAutoSkip').onchange = function () {
    AUTO.on = this.checked;
    try { localStorage.setItem('dxk.autoskip', AUTO.on ? '1' : '0'); } catch (e) {}
    updatePctl();
    toast(AUTO.on ? '已开启：起播自动跳片头，播到片尾自动下一集' : '已关闭自动跳过片头片尾');
  };
  $('setRate').oninput = function () { setSpeed(this.value); };
  $('setRate').onchange = function () { toast('默认倍速已设为 ' + speedLabel(V.speed)); };
  $('setGesture').onchange = function () {
    GEST.on = this.checked;
    try { localStorage.setItem('dxk.gesture', GEST.on ? '1' : '0'); } catch (e) {}
    toast(GEST.on ? '已开启触摸手势' : '已关闭触摸手势');
  };
  $('btnCast').onclick = function () { castScan(true); };
  $('btnDl').onclick = dlCurrent;

  // 本机缓存：片单 / 封面自动缓存，这里只提供一键清空
  $('btnCacheClear').onclick = function () {
    if (!CACHE) { toast('这台设备不支持本机缓存'); return; }
    if (!confirm('清空本机缓存的片单和封面？收藏、观看历史、播放进度不受影响。')) return;
    CACHE.clearAll().then(function () {
      toast('已清空本机缓存');
      renderCacheTip();
    });
  };

  // 手机 / 平板连接电脑
  $('btnSrvSave').onclick = function () {
    var v = $('srvUrl').value.trim();
    if (!v) { toast('请先填写电脑地址'); return; }
    $('srvMsg').textContent = '';
    saveServer(v);
  };
  $('srvUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnSrvSave').click(); });
  $('btnSrvClear').onclick = function () {
    if (!SERVER) { toast('当前已经是独立运行'); return; }
    if (!confirm('断开电脑连接？断开后投屏、播放电脑本地文件会不可用，看片不受影响。')) return;
    clearServer();
  };
  $('btnSrvGuide').onclick = function () {
    var sm = $('setupModal');
    if (!sm) return;
    var u = $('setupUrl');
    if (u && !u.value) u.value = SERVER || '';
    var m = $('setupMsg');
    if (m) m.textContent = '';
    sm.classList.add('show');
  };
  $('btnSrvCopy').onclick = function () {
    var t = $('srvShow');
    if (!t.value) { toast('地址还没读出来，请稍候'); return; }
    t.removeAttribute('readonly');
    t.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    t.setAttribute('readonly', 'readonly');
    toast(ok ? '地址已复制，去手机里粘贴' : ('请手动记下：' + t.value), ok ? 2600 : 5000);
  };
  $('btnSetupOk').onclick = function () {
    var v = $('setupUrl').value.trim();
    if (!v) { $('setupMsg').textContent = '请先填写电脑地址'; return; }
    $('setupMsg').textContent = '';
    saveServer(v);
  };
  $('setupUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnSetupOk').click(); });
  $('btnSetupRetry').onclick = $('btnSetupOk').onclick;

  document.querySelectorAll('[data-nav]').forEach(function (a) {
    a.onclick = function () { go(a.dataset.nav); };
  });

  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeSet(); });

  document.addEventListener('keydown', function (e) {
    var open = $('player').classList.contains('show');
    if (e.key === 'Escape') {
      if ($('pickModal').classList.contains('show')) { closePick(); return; }
      if (open) {
        if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (x) {} }
        else closePlayer();
      } else if ($('authModal').classList.contains('show')) closeAuth();
      else closeSet();
      return;
    }
    if (!open) return;
    var tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    switch (e.key) {
      case ' ': case 'k': case 'K':
        e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); seekBy(-5); break;
      case 'ArrowRight': e.preventDefault(); seekBy(5); break;
      case 'ArrowUp': e.preventDefault(); keyboardVol(0.05); break;
      case 'ArrowDown': e.preventDefault(); keyboardVol(-0.05); break;
      case 'f': case 'F': toggleFull(); break;
      case 'm': case 'M': $('video').muted = !$('video').muted; break;
    }
    showCtl();
  });

  // 自定义播放地址输入框支持拖放本地文件
  var cu = $('customUrl');
  cu.addEventListener('dragover', function (e) { e.preventDefault(); });
  cu.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer.files[0];
    if (f) cu.value = f.path || f.name;
  });

  /* ------------------------------------------------ 启动 */

  if (window.Cloud) window.Cloud.loadSession();
  updateUserBtn();
  updatePctl();
  installImgFallback();
  if (isLocal()) window.DXK_LOCAL.installNativeXhr();

  /* 手机「返回键」：先关播放器 / 弹窗，再退回上一级页面，最后才退出 App。
     安卓壳（MainActivity）按返回键时调用这里，返回 true 表示已处理、不要退出。 */
  window.__dxkBack = function () {
    if ($('player').classList.contains('show')) {
      if (FS_ON) { applyFs(false); return true; }   // 全屏里先退出全屏，不直接关播放器
      closePlayer();
      return true;
    }
    var modal = document.querySelector('.modal.show');
    if (modal) { modal.classList.remove('show'); return true; }
    var act = document.querySelector('.page.active');
    var name = act ? act.id.replace('page-', '') : 'home';
    if (name === 'detail' || name === 'search') {
      go(S.cur && TABS.indexOf(S.cur) >= 0 ? S.cur : 'home');
      return true;
    }
    if (name !== 'home') { go('home'); return true; }
    return false;
  };
  loadFavs().then(function () {
    // 手机 App 第一次打开还没配电脑地址：先让用户填，填好再拉数据
    if (needSetup()) return;
    go('home');
    loadSites();               // 片单不依赖它，只是拿源名字给线路条用
    if (cloudReady()) syncAll();
  });
})();