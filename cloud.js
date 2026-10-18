/* ============================================================
   独享库 · 云同步底层（Supabase）
   ------------------------------------------------------------
   纯浏览器 fetch 实现，不用任何第三方库，电脑 / 安卓 / iOS 三端通用。
   只负责「登录 / 取数据 / 存数据」，具体同步逻辑在 app.js 里。
   ============================================================ */
window.Cloud = (function () {
  'use strict';

  var CFG = window.DXK_CONFIG || {};
  var BASE = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
  var KEY = String(CFG.supabaseAnonKey || '');
  var TABLES = CFG.tables || {};
  var LS_KEY = 'dxk.session';

  var session = null;

  function enabled() { return !!(BASE && KEY); }
  function table(k, dft) { return TABLES[k] || dft; }

  function loadSession() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) { session = null; }
    return session;
  }

  function saveSession(s) {
    session = s || null;
    try {
      if (s) localStorage.setItem(LS_KEY, JSON.stringify(s));
      else localStorage.removeItem(LS_KEY);
    } catch (e) {}
  }

  function baseHeaders(auth) {
    var h = { 'apikey': KEY, 'Content-Type': 'application/json' };
    if (auth) h['Authorization'] = 'Bearer ' + auth;
    return h;
  }

  // 统一请求：返回解析后的 JSON，出错抛出带中文说明的 Error
  function http(path, opt) {
    opt = opt || {};
    return fetch(BASE + path, {
      method: opt.method || 'GET',
      headers: opt.headers || {},
      body: opt.body != null ? JSON.stringify(opt.body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var m = (j && (j.error_description || j.msg || j.message || j.error || j.hint)) || ('HTTP ' + r.status);
          if (r.status === 400 && /already registered/i.test(m)) m = '这个邮箱已经注册过了，请直接点「登录」';
          if (r.status === 400 && /invalid login credentials/i.test(m)) m = '邮箱或密码不对';
          if (r.status === 422 && /email/i.test(m)) m = '邮箱格式不对（要用真实邮箱地址）';
          var err = new Error(m);
          err.status = r.status;
          err.data = j;
          throw err;
        }
        return j;
      });
    });
  }

  function storeAuth(d) {
    if (!d || !d.access_token) return session;
    saveSession({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + ((d.expires_in || 3600) * 1000) - 60000,
      user: d.user || (session && session.user) || null
    });
    return session;
  }

  function signUp(email, pw) {
    return http('/auth/v1/signup', {
      method: 'POST', headers: baseHeaders(), body: { email: email, password: pw }
    }).then(function (d) {
      if (d && d.access_token) { storeAuth(d); return { loggedIn: true }; }
      return { loggedIn: false, needConfirm: true };
    });
  }

  function signIn(email, pw) {
    return http('/auth/v1/token?grant_type=password', {
      method: 'POST', headers: baseHeaders(), body: { email: email, password: pw }
    }).then(function (d) { storeAuth(d); return { loggedIn: true }; });
  }

  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(new Error('登录已失效，请重新登录'));
    return http('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: baseHeaders(), body: { refresh_token: session.refresh_token }
    }).then(function (d) { storeAuth(d); return session; });
  }

  function signOut() {
    var tok = session && session.access_token;
    saveSession(null);
    if (!tok) return Promise.resolve();
    return http('/auth/v1/logout', { method: 'POST', headers: baseHeaders(tok) }).catch(function () {});
  }

  function ensureToken() {
    if (!session || !session.access_token) return Promise.reject(new Error('未登录'));
    if (session.expires_at && Date.now() < session.expires_at) return Promise.resolve(session.access_token);
    return refresh().then(function () { return session.access_token; });
  }

  // 调用数据库（PostgREST）
  function rest(path, opt) {
    return ensureToken().then(function (tok) {
      opt = opt || {};
      var h = baseHeaders(tok);
      if (opt.prefer) h['Prefer'] = opt.prefer;
      return http('/rest/v1/' + path, { method: opt.method, headers: h, body: opt.body });
    });
  }

  function isLoggedIn() { return !!(session && session.access_token); }
  function user() { return session && session.user; }
  function uid() { var u = user(); return u && u.id; }
  function email() { var u = user(); return u && u.email; }

  return {
    enabled: enabled, table: table, loadSession: loadSession, saveSession: saveSession,
    signUp: signUp, signIn: signIn, signOut: signOut, refresh: refresh,
    ensureToken: ensureToken, rest: rest, isLoggedIn: isLoggedIn,
    user: user, uid: uid, email: email
  };
})();