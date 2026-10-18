/* ============================================================
   独享库 · 手机端本地实现（无后端独立运行）
   ------------------------------------------------------------
   手机 App（Capacitor）里没有 Python 后端，本文件用纯 JS 直接请求
   各影视源的苹果 CMS 采集接口（api.php/provide/vod/），并 1:1 复刻
   server.py 里对应接口的返回结构，前端 app.js 无需感知差异。

   什么时候生效：手机 App 且没填电脑地址时（app.js 里的分流判断）。
   数据落点：source 列表 / 分类缓存 / 收藏 / 历史 / 进度 全部存 localStorage。
   网络请求：优先走 Capacitor 原生 HTTP（绕过 CORS），没有则降级 fetch。
   ============================================================ */
window.DXK_LOCAL = (function () {
  'use strict';

  /* ------------------------------------------------ 内置源（与 server.py 一致） */

  var BUILTIN_ID = 'builtin-cms';
  // 顺序 = 实测流畅度，越靠前越流畅（与 server.py 的 BUILTIN_CMS 保持同步）
  var BUILTIN_CMS = [
    ['极速资源', 'https://jisuziyuan.com/api.php/provide/vod/'],
    ['极速资源2', 'https://jszyapi.com/api.php/provide/vod/'],
    ['量子资源', 'https://cj.lziapi.com/api.php/provide/vod/'],
    ['非凡资源', 'https://cj.ffzyapi.com/api.php/provide/vod/'],
    ['暴风资源', 'https://bfzyapi.com/api.php/provide/vod/'],
    ['百度资源', 'https://api.apibdzy.com/api.php/provide/vod/'],
    ['金鹰资源', 'https://jinyingzy.com/api.php/provide/vod/'],
    ['索尼资源', 'https://suoniapi.com/api.php/provide/vod/'],
    ['魔都资源', 'https://www.mdzyapi.com/api.php/provide/vod/'],
    ['天涯资源', 'http://tyyszy.com/api.php/provide/vod/'],
    ['虎牙资源', 'https://www.huyaapi.com/api.php/provide/vod/'],
    ['最大资源', 'https://api.zuidapi.com/api.php/provide/vod/'],
    ['电影天堂', 'https://caiji.dyttzyapi.com/api.php/provide/vod/'],
    ['无尽资源', 'https://wujinapi.com/api.php/provide/vod/'],
    ['红牛资源', 'https://www.hongniuzy2.com/api.php/provide/vod/'],
    ['360影视', 'https://www.360zy.com/api.php/provide/vod/']
  ];

  var LS_SRC = 'dxk.sources';
  var LS_CATS = 'dxk.cats.';
  var LS_FAV = 'dxk.fav';
  var LS_HIS = 'dxk.his';
  var LS_PROG = 'dxk.prog';
  var LS_DEAD = 'dxk.dead';

  var CATS_TTL = 24 * 3600 * 1000;   // 分类缓存 24 小时
  var NET_TIMEOUT = 15000;           // 单次请求超时 15 秒
  var CONCURRENCY = 5;               // 并发上限

  var PLACEHOLDER = { ok: false, error: '手机版暂不支持（需要电脑端）' };

  /* ------------------------------------------------ MD5（与 Python hashlib 对齐，用于生成源 key） */

  function utf8Bytes(str) {
    str = String(str);
    if (window.TextEncoder) return new TextEncoder().encode(str);
    var out = [], i, c, c2, cp;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        i++;
        c2 = str.charCodeAt(i);
        cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return new Uint8Array(out);
  }

  var MD5_K = null;
  var MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  function hexLE(x) {
    var s = '', i, b;
    for (i = 0; i < 4; i++) {
      b = (x >>> (8 * i)) & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }

  function md5hex(str) {
    if (!MD5_K) {
      MD5_K = [];
      for (var k = 0; k < 64; k++) MD5_K.push(Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296));
    }
    var bytes = utf8Bytes(str);
    var n = bytes.length;
    var padLen = (((n + 8) >> 6) + 1) << 6;
    var buf = new Uint8Array(padLen);
    buf.set(bytes);
    buf[n] = 0x80;
    var bitLen = n * 8;
    var lo = bitLen >>> 0;
    var hi = Math.floor(bitLen / 4294967296);
    for (var i = 0; i < 4; i++) buf[padLen - 8 + i] = (lo >>> (8 * i)) & 0xff;
    for (i = 0; i < 4; i++) buf[padLen - 4 + i] = (hi >>> (8 * i)) & 0xff;

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var off = 0; off < padLen; off += 64) {
      var M = new Array(16);
      for (i = 0; i < 16; i++) {
        M[i] = buf[off + 4 * i] | (buf[off + 4 * i + 1] << 8) |
               (buf[off + 4 * i + 2] << 16) | (buf[off + 4 * i + 3] << 24);
      }
      var A = a0, B = b0, C = c0, D = d0, F, g, t;
      for (i = 0; i < 64; i++) {
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        t = MD5_S[i];
        B = (B + ((F << t) | (F >>> (32 - t)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
  }

  function srcId(url) { return md5hex(url).slice(0, 12); }

  /* python json.dumps(sort_keys=True) 的等效写法（hs 用） */
  function jsonSort(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Object.prototype.toString.call(v) === '[object Array]') {
      return '[' + v.map(jsonSort).join(', ') + ']';
    }
    if (typeof v === 'object') {
      var ks = Object.keys(v).sort();
      return '{' + ks.map(function (k) {
        return JSON.stringify(String(k)) + ': ' + jsonSort(v[k]);
      }).join(', ') + '}';
    }
    return JSON.stringify(String(v));
  }

  /* 稳定短哈希（与 server.py 的 hs 一致） */
  function hs(v) { return md5hex(jsonSort(v)).slice(0, 10); }

  /* ------------------------------------------------ 本地存储 */

  function lsGet(key, dft) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return dft;
      return JSON.parse(raw);
    } catch (e) { return dft; }
  }

  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ------------------------------------------------ 网络层：优先原生 HTTP，降级 fetch */

  function capHttp() {
    var c = window.Capacitor;
    return (c && c.Plugins && c.Plugins.CapacitorHttp) || null;
  }

  /* 公网版：前端被托管在网页空间（如 Cloudflare Pages），采集源接口不带跨域头，
     浏览器直接取会被拦。这时把请求交给一个很小的接口代理（见 公网版/worker.js），
     由它代取再带跨域头回来。只在「没有原生 HTTP + 配了代理地址」时生效 ——
     安卓原生走 CapacitorHttp、电脑版走 Python 后端，都到不了这里。 */
  function proxyUrl(url) {
    var pre = window.DXK_CMS_PROXY;
    if (!pre || capHttp()) return url;
    if (!/^https?:\/\//i.test(url)) return url;
    return String(pre).replace(/\/+$/, '') + '/?url=' + encodeURIComponent(url);
  }

  /* 统一 GET：始终 resolve（失败给 ''），不抛错 */
  function httpGet(url, headers, timeout) {
    headers = headers || {};
    var ms = timeout || NET_TIMEOUT;
    var cap = capHttp();
    if (cap && cap.get) {
      return cap.get({
        url: url, headers: headers,
        connectTimeout: ms, readTimeout: ms
      }).then(function (res) {
        var d = res && res.data;
        if (d === null || d === undefined) return '';
        if (typeof d === 'string') return d;
        try { return JSON.stringify(d); } catch (e) { return ''; }
      }).catch(function () { return fetchGet(url); });
    }
    return fetchGet(url);
  }

  function fetchGet(url) {
    if (typeof fetch !== 'function') return Promise.resolve('');
    return fetch(proxyUrl(url)).then(function (r) { return r.text(); })
      .catch(function () { return ''; });
  }

  /* 超时兜底：到点直接给 null，避免个别源把整体拖死 */
  function withTimeout(p, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      p.then(function (v) {
        if (done) return; done = true; clearTimeout(t); resolve(v);
      }, function () {
        if (done) return; done = true; clearTimeout(t); resolve(null);
      });
    });
  }

  /* 受限并发执行：一次最多 limit 个，单个失败不影响整体 */
  function pool(items, limit, worker) {
    return new Promise(function (resolve) {
      var out = new Array(items.length), idx = 0, active = 0, n = items.length;
      if (!n) return resolve(out);
      function next() {
        if (idx >= n && active === 0) return resolve(out);
        while (active < limit && idx < n) {
          (function (i) {
            active++; idx++;
            var job;
            try { job = Promise.resolve(worker(items[i])); }
            catch (e) { job = Promise.resolve(null); }
            job.then(function (v) { out[i] = v; }, function () { out[i] = null; })
               .then(function () { active--; next(); });
          })(idx);
        }
      }
      next();
    });
  }

  /* ------------------------------------------------ 通用小工具（对应 server.py） */

  function cleanUrl(u) {
    return String(u === null || u === undefined ? '' : u).trim()
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
  }

  function looksPlayable(u) {
    if (!u || typeof u !== 'string') return false;
    var ul = u.toLowerCase().split('?')[0];
    return /\.(m3u8|mp4|flv|ts|mkv|avi|mov|m4v|mp3|m4a)$/.test(ul);
  }

  function joinApi(api, params) {
    api = String(api || '').trim();
    if (!api) return '';
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined) return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    var q = parts.join('&');
    return api + (api.indexOf('?') >= 0 ? '&' : '?') + q;
  }

  /* 宽容 JSON 解析：支持 BOM、前后杂质、JSONP（已解析好的对象原样返回） */
  function safeJson(text) {
    if (!text) return null;
    if (typeof text === 'object') return text;
    var t = String(text).replace(/^\ufeff/, '').trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) {}
    var pairs = [['{', '}'], ['[', ']']];
    for (var i = 0; i < pairs.length; i++) {
      var a = pairs[i][0], b = pairs[i][1];
      var x = t.indexOf(a), y = t.lastIndexOf(b);
      if (x >= 0 && y > x) {
        try { return JSON.parse(t.slice(x, y + 1)); } catch (e) {}
      }
    }
    var m = t.match(/[\w$.]+\s*\(\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*\)\s*;?\s*$/);
    if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    return null;
  }

  function originOf(url) {
    var m = String(url || '').match(/^([a-z]+:\/\/[^\/]+)/i);
    return m ? m[1] : '';
  }

  /* ------------------------------------------------ 采集接口解析（对应 server.py） */

  function parseClass(data) {
    var out = [];
    if (data && typeof data === 'object' && !(data instanceof Array) && data['class']) {
      var cls = data['class'] || [];
      for (var i = 0; i < cls.length; i++) {
        var c = cls[i];
        if (!c || typeof c !== 'object') continue;
        var tid = c.type_id;
        tid = String((tid === null || tid === undefined) ? (c.id === undefined ? '' : c.id) : tid);
        var name = c.type_name || c.name || tid;
        if (tid) out.push({ id: tid, name: String(name) });
      }
    }
    return out;
  }

  /* 分类树：[{id,name,pid}]，pid='0' 为顶层分类。
     注意：采集站的顶层分类（电影 / 连续剧 / 综艺 / 动漫）本身几乎没有内容，
     片子全挂在它们的子分类下，所以要把父子关系一起带出来。 */
  function parseClassTree(data) {
    var out = [];
    if (data && typeof data === 'object' && !(data instanceof Array) && data['class']) {
      var cls = data['class'] || [];
      for (var i = 0; i < cls.length; i++) {
        var c = cls[i];
        if (!c || typeof c !== 'object') continue;
        var tid = c.type_id;
        tid = String((tid === null || tid === undefined) ? (c.id === undefined ? '' : c.id) : tid);
        if (!tid) continue;
        var pid = c.type_pid;
        pid = String((pid === null || pid === undefined) ? '0' : pid);
        var name = c.type_name || c.name || tid;
        out.push({ id: tid, name: String(name), pid: pid });
      }
    }
    return out;
  }

  function normVideo(v) {
    return {
      id: String(v.vod_id || v.id || ''),
      name: String(v.vod_name || v.name || ''),
      pic: cleanUrl(v.vod_pic || v.pic || ''),
      remarks: String(v.vod_remarks || v.vod_note || v.remarks || ''),
      year: String(v.vod_year || ''),
      type: String(v.type_name || ''),
      score: String(v.vod_score || '')
    };
  }

  function parseVideos(data) {
    var out = [], i, v;
    if (data && typeof data === 'object' && !(data instanceof Array)) {
      var list = data.list || [];
      for (i = 0; i < list.length; i++) {
        v = list[i];
        if (v && typeof v === 'object') out.push(normVideo(v));
      }
    } else if (data instanceof Array) {
      for (i = 0; i < data.length; i++) {
        v = data[i];
        if (v && typeof v === 'object') out.push(normVideo(v));
      }
    }
    return out.filter(function (x) { return !!x.id; });
  }

  /* 详情：{list:[{...vod_play_from, vod_play_url}]} */
  function parseDetail(data) {
    var items = [];
    if (data && typeof data === 'object' && !(data instanceof Array)) items = data.list || [];
    else if (data instanceof Array) items = data;
    if (!items.length) return null;
    var v = items[0];
    if (!v || typeof v !== 'object') return null;

    var info = normVideo(v);
    info.content = String(v.vod_content || v.des || '').trim().replace(/<[^>]+>/g, '');
    info.actor = String(v.vod_actor || '');
    info.director = String(v.vod_director || '');
    info.area = String(v.vod_area || '');
    info.lang = String(v.vod_lang || '');

    var froms = String(v.vod_play_from || '').split('$$$');
    var urls = String(v.vod_play_url || '').split('$$$');
    var groups = [];
    for (var i = 0; i < froms.length; i++) {
      var raw = i < urls.length ? urls[i] : '';
      var segs = raw.split('#');
      var eps = [];
      for (var j = 0; j < segs.length; j++) {
        var seg = String(segs[j]).trim();
        if (!seg) continue;
        var nm, u;
        var k = seg.indexOf('$');
        if (k >= 0) { nm = seg.slice(0, k); u = seg.slice(k + 1); }
        else { nm = seg; u = seg; }
        u = cleanUrl(u);
        if (!u) continue;
        eps.push({ name: String(nm).trim() || ('第' + (eps.length + 1) + '集'), url: u });
      }
      if (eps.length) {
        groups.push({
          from: String(froms[i]).trim() || ('线路' + (i + 1)),
          episodes: eps
        });
      }
    }
    info.groups = groups;
    return info;
  }

  /* ------------------------------------------------ 分类归并（与 server.py 一致的两级逻辑） */

  var CAT_ALIAS = {
    '电影片': '电影', '电影': '电影',
    '连续剧': '电视剧', '电视剧片': '电视剧', '电视剧': '电视剧',
    '动漫片': '动漫', '动画': '动漫', '动漫': '动漫',
    '综艺片': '综艺', '综艺': '综艺',
    '记录片': '纪录片', '纪录片': '纪录片',
    '体育赛事': '体育', '体育': '体育'
  };

  var CAT_ORDER = ['电影', '电视剧', '综艺', '动漫', '纪录片', '体育'];
  var CAT_SPORT = ['体育', '足球', '篮球', 'NBA', 'CBA', '英超', '西甲', '德甲', '意甲',
    '法甲', '中超', '网球', '斯诺克', '赛车', '电竞', '羽毛球', '乒乓球',
    '排球', '橄榄球', '棒球', '冰球', '格斗', 'UFC'];

  /* 只把一级分类的名字规范化，子分类原样保留，避免和上层重名 */
  function catFixTop(items) {
    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      if ((c.pid || '0') === '0') {
        var alias = CAT_ALIAS[String(c.name || '').trim()];
        if (alias) c.name = alias;
      }
    }
    return items;
  }

  /* 按分类名猜它属于哪个大类；猜不出来就返回空（保持顶层） */
  function catGroup(name) {
    var n = String(name || '').trim();
    if (!n) return '';
    if (n.indexOf('动漫') >= 0 || n.indexOf('动画') >= 0) return '动漫';
    if (n.indexOf('综艺') >= 0) return '综艺';
    if (n.indexOf('纪录') >= 0 || n.indexOf('记录') >= 0 || n.indexOf('纪实') >= 0) return '纪录片';
    for (var i = 0; i < CAT_SPORT.length; i++) {
      if (n.indexOf(CAT_SPORT[i]) >= 0) return '体育';
    }
    if (/片$/.test(n)) return '电影';
    if (/剧$/.test(n)) return '电视剧';
    if (n.indexOf('电影') >= 0) return '电影';
    return '';
  }

  /* 把一盘平级分类收成「大类 + 原分类」两级；虚拟大类 id 用 g1..g6 */
  function catGrouped(flat) {
    var buckets = {}, rest = [], i, c, g;
    for (i = 0; i < flat.length; i++) {
      c = flat[i];
      g = catGroup(c.name);
      if (g) (buckets[g] = buckets[g] || []).push(c);
      else rest.push(c);
    }
    if (!Object.keys(buckets).length) return flat;
    var out = [];
    for (i = 0; i < CAT_ORDER.length; i++) {
      g = CAT_ORDER[i];
      var lst = buckets[g];
      if (!lst || !lst.length) continue;
      var gid = 'g' + (i + 1);
      out.push({ id: gid, name: g, pid: '0', virtual: 1 });
      for (var j = 0; j < lst.length; j++) {
        out.push({ id: lst[j].id, name: lst[j].name, pid: gid });
      }
    }
    for (i = 0; i < rest.length; i++) {
      out.push({ id: rest[i].id, name: rest[i].name, pid: '0' });
    }
    return out;
  }

  /* 一级菜单去杂：很多源把「伦理片 / 预告片 / 电影解说 / 福利」这类其实是细分
     类型的分类也放在顶层，手机上一级菜单会被十几个杂项撑爆。这里把「自己没
     子分类」的顶层分类挂到名字能对上的大类下面，实在归不了类的收进「其他」。 */
  function catTidy(items) {
    function isTop(c) { return String(c.pid || '0') === '0'; }
    var parents = {}, i;
    for (i = 0; i < items.length; i++) {
      if (!isTop(items[i])) parents[String(items[i].pid)] = 1;
    }
    var topsWithKids = items.filter(function (c) { return isTop(c) && parents[String(c.id)]; });
    var big = {};
    topsWithKids.forEach(function (c) {
      var g = catGroup(c.name);
      if (g && !big[g]) big[g] = String(c.id);
    });

    var pending = [];
    items.filter(function (x) { return isTop(x) && !parents[String(x.id)]; })
      .forEach(function (c) {
        var name = String(c.name || '').trim();
        var target = '';
        for (var j = 0; j < topsWithKids.length; j++) {
          var n2 = String(topsWithKids[j].name || '').trim();
          if (n2 && name && (name.indexOf(n2) >= 0 || n2.indexOf(name) >= 0)) {
            target = String(topsWithKids[j].id);
            break;
          }
        }
        if (!target) {
          var g = catGroup(name);
          if (g && big[g]) target = big[g];
        }
        if (target && target !== String(c.id)) c.pid = target;
        else pending.push(c);
      });

    if (pending.length) {
      items.push({ id: '__other__', name: '其他', pid: '0', virtual: 1 });
      pending.forEach(function (c) { c.pid = '__other__'; });
    }
    return items;
  }

  /* 手机端没有预索引，拿不到每个分类的实测条数：
     未实测（cnt 为空）的分类一律保留，其余逻辑与 server.py 的 cats_usable 相同。
     顶层分类（电影 / 连续剧 …）自身的空壳由 cat_descendants 聚合子分类内容。 */
  function catsUsable(rows) {
    if (!rows || !rows.length) return [];
    var ids = {}, i;
    for (i = 0; i < rows.length; i++) ids[rows[i].tid] = 1;
    var withContent = {};
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.cnt === null || r.cnt === undefined || r.cnt > 0) withContent[r.pid || '0'] = 1;
    }
    var out = [];
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      var keep = (row.cnt === null || row.cnt === undefined || row.cnt > 0) || withContent[row.tid];
      if (!keep) continue;
      var pid = row.pid || '0';
      // pid 指向一个不存在的分类时，按顶层处理，避免前端成孤儿
      if (pid !== '0' && !ids[pid]) pid = '0';
      out.push({ id: row.tid, name: row.name, pid: pid });
    }
    var real = {};
    for (i = 0; i < out.length; i++) real[out[i].id] = 1;
    var hier = false;
    for (i = 0; i < out.length; i++) {
      if (out[i].pid !== '0' && real[out[i].pid]) { hier = true; break; }
    }
    if (hier) return catTidy(catFixTop(out));
    return catTidy(catGrouped(out));
  }

  /* 某分类及其全部子分类 id（用于父类目聚合）
     虚拟大类（g1..g6 / __other__）直接展开成它的成员分类 id。 */
  function catDescendants(treeRows, key, tid) {
    tid = String(tid);
    var usable = catsUsable(treeRows || []);
    var isVirtual = usable.some(function (c) {
      return String(c.id) === tid && c.virtual;
    });
    if (isVirtual) {
      var members = usable.filter(function (c) { return String(c.pid) === tid; })
        .map(function (c) { return c.id; });
      return members.length ? members : [tid];
    }
    if (!treeRows || !treeRows.length) return [tid];
    var kids = {}, i;
    for (i = 0; i < treeRows.length; i++) {
      var r = treeRows[i];
      // 原始分类行（?ac=list 解析出来的）用 tid，catGrouped 归一化后的用 id
      var ri = (r.id === undefined || r.id === null || r.id === '') ? r.tid : r.id;
      if (ri === undefined || ri === null || ri === '') continue;
      var rp = (r.pid === undefined || r.pid === null || r.pid === '') ? '0' : String(r.pid);
      (kids[rp] = kids[rp] || []).push(String(ri));
    }
    // 广度优先：先父后子、同级保持原始顺序，这样 slice(0,8) 拿到的是主要子分类
    var out = [], seen = {}, queue = [tid], qi = 0;
    while (qi < queue.length) {
      var t = queue[qi++];
      if (seen[t]) continue;
      seen[t] = 1;
      out.push(t);
      var ks = kids[t] || [];
      for (i = 0; i < ks.length; i++) queue.push(ks[i]);
    }
    return out;
  }

  /* ------------------------------------------------ 源与站点 */

  function builtinSource() {
    var sites = BUILTIN_CMS.map(function (it) {
      var api = it[1];
      return {
        key: 'cms_' + srcId(api), name: it[0], type: '1', api: api,
        ext: '', searchable: 1, quickSearch: 1, filterable: 1,
        playerType: '', jar: '', spider: false,
        source: BUILTIN_ID, sourceName: '内置采集站'
      };
    });
    return {
      id: BUILTIN_ID, name: '内置采集站', url: 'builtin://cms',
      enabled: true, addedAt: 0, sites: sites, parses: [], builtin: true
    };
  }

  /* 源列表：内置源固定在第一位（站点定义始终取最新常量），用户自建源存 localStorage */
  function loadSources() {
    var list = lsGet(LS_SRC, null);
    if (!list || !(list instanceof Array) || !list.length) list = [builtinSource()];
    var hasBuiltin = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === BUILTIN_ID) {
        hasBuiltin = true;
        var fresh = builtinSource();
        list[i].name = fresh.name;
        list[i].url = fresh.url;
        list[i].sites = fresh.sites;
        list[i].parses = list[i].parses || [];
        list[i].builtin = true;
        if (list[i].enabled === undefined) list[i].enabled = true;
      }
    }
    if (!hasBuiltin) list.unshift(builtinSource());
    return list;
  }

  function saveSources(list) {
    // 内置源每次都从常量重建，不必落盘
    lsSet(LS_SRC, list.filter(function (s) { return !s.builtin; }));
  }

  function deadKeys() {
    var d = lsGet(LS_DEAD, []);
    return (d instanceof Array) ? d : [];
  }

  function allSites() {
    var out = [];
    loadSources().forEach(function (src) {
      if (src.enabled === false) return;
      (src.sites || []).forEach(function (s) { out.push(s); });
    });
    return out;
  }

  /* 只保留能在纯 JS 后端真正运行的站点（HTTP 采集站） */
  function usableSites() {
    var dead = deadKeys();
    return allSites().filter(function (s) {
      return String(s.api || '').indexOf('http') === 0 && dead.indexOf(s.key) < 0;
    });
  }

  function siteByKey(key) {
    var all = [];
    loadSources().forEach(function (src) {
      (src.sites || []).forEach(function (s) { all.push(s); });
    });
    for (var i = 0; i < all.length; i++) {
      if (all[i].key === key) return all[i];
    }
    return null;
  }

  /* 调用采集接口 */
  function callVod(site, params, timeout) {
    var api = (site && site.api) || '';
    if (!api || api.indexOf('http') !== 0) return Promise.resolve(null);
    var ms = timeout || NET_TIMEOUT;
    var url = joinApi(api, params);
    var headers = { 'Referer': api, 'Origin': originOf(api) };
    return withTimeout(httpGet(url, headers, ms), ms + 1000).then(function (text) {
      return safeJson(text);
    });
  }

  /* ------------------------------------------------ 分类缓存（localStorage，24 小时） */

  function catsCacheGet(key) {
    var it = lsGet(LS_CATS + key, null);
    if (!it || !(it.rows instanceof Array) || !it.t) return null;
    if (Date.now() - it.t > CATS_TTL) return null;
    return it.rows;
  }

  function catsCachePut(key, rows) {
    lsSet(LS_CATS + key, { t: Date.now(), rows: rows });
  }

  /* 拉某源的 ?ac=list 分类树（带缓存） */
  function fetchCats(key) {
    var cached = catsCacheGet(key);
    if (cached) return Promise.resolve(cached);
    var site = siteByKey(key);
    if (!site) return Promise.resolve([]);
    return callVod(site, { ac: 'list' }, 12000).then(function (data) {
      var rows = parseClassTree(data).map(function (c) {
        return { tid: c.id, name: c.name, pid: c.pid, cnt: undefined };
      });
      if (rows.length) catsCachePut(key, rows);
      return rows;
    });
  }

  /* ------------------------------------------------ 采集站接口判定（对应 server.py） */

  function _srcId(url) { return srcId(url); }

  function isCmsApi(url) {
    var ul = String(url || '').toLowerCase();
    if (ul.indexOf('http') !== 0) return false;
    if (ul.indexOf('provide/vod') >= 0) return true;
    var base = ul.split('?')[0].replace(/\/+$/, '');
    return /api\.php$/.test(base) && ul.indexOf('ac=') < 0;
  }

  /* 把一个采集站接口直接包装成站点（用户只填一个接口地址也能用） */
  function cmsApiToSite(url, label) {
    var api = String(url || '').split('?')[0];
    var host = (api.match(/^[a-z]+:\/\/([^\/]+)/i) || [])[1] || '';
    var name = String(label || '').trim() || host;
    return callVod({ api: api }, { ac: 'list' }, 15000).then(function (data) {
      var cls = parseClass(data);
      if (!cls.length) return null;
      return {
        key: 'cms_' + srcId(api), name: name, type: '1', api: api,
        ext: '', searchable: 1, quickSearch: 1, filterable: 1,
        playerType: '', jar: '', spider: false,
        source: srcId(api), sourceName: '自建采集站', 'class': cls
      };
    });
  }

  function normalizeSite(s, sid, sname) {
    if (!s || typeof s !== 'object') return null;
    var api = cleanUrl(s.api || '');
    var jar = cleanUrl(s.jar || '');
    var name = String(s.name || '').trim();
    if (!name) return null;
    var key = String(s.key || hs({ n: name, a: api, s: sid })).trim();
    return {
      key: key,
      name: name,
      type: String(s.type === undefined ? '1' : s.type),
      api: api,
      ext: typeof s.ext === 'string' ? s.ext : (s.ext ? JSON.stringify(s.ext) : ''),
      searchable: parseInt(s.searchable === undefined ? 1 : s.searchable, 10) || 0,
      quickSearch: parseInt(s.quickSearch === undefined ? 1 : s.quickSearch, 10) || 0,
      filterable: parseInt(s.filterable === undefined ? 0 : s.filterable, 10) || 0,
      playerType: String(s.playerType || ''),
      jar: jar,
      spider: !!jar && !api,
      source: sid,
      sourceName: sname
    };
  }

  function extractSites(data, sid, sname) {
    var out = [];
    function push(raw) {
      if (typeof raw === 'string') raw = safeJson(raw);
      var s = normalizeSite(raw, sid, sname);
      if (s && s.api && s.api.indexOf('http') === 0) out.push(s);
    }
    if (data && typeof data === 'object' && !(data instanceof Array)) {
      (data.sites || []).forEach(push);
    } else if (data instanceof Array) {
      data.forEach(push);
    }
    return out;
  }

  function extractParses(data) {
    var out = [];
    if (!data || typeof data !== 'object' || data instanceof Array) return out;
    (data.parses || []).forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var url = cleanUrl(raw.url || '');
      if (!url) return;
      var ext = raw.ext || {};
      var flag = (ext && typeof ext === 'object') ? ext.flag : null;
      out.push({
        name: raw.name || '解析',
        type: parseInt(raw.type === undefined ? 1 : raw.type, 10) || 1,
        url: url,
        flag: (flag instanceof Array) ? flag : []
      });
    });
    return out;
  }

  /* 拉取并解析一份配置（采集接口 / rule.json / 多仓） */
  function fetchConfig(url, depth, label) {
    depth = depth || 0;
    url = cleanUrl(url);
    var result = { ok: false, error: '', sites: [], parses: [], name: '', children: [], url: url };
    if (!url) { result.error = '地址为空'; return Promise.resolve(result); }

    if (isCmsApi(url) && depth === 0) {
      return cmsApiToSite(url, label).then(function (s) {
        if (s) { result.ok = true; result.sites = [s]; result.name = s.name; return result; }
        result.error = '该采集接口无法访问（地址已失效或被限制）';
        return result;
      });
    }

    return httpGet(url, { 'Referer': url }, 20000).then(function (text) {
      if (!text) { result.error = '无法访问该地址（网络不通 / 需要代理 / 地址已失效）'; return result; }
      var data = safeJson(text);
      if (data === null) { result.error = '返回内容不是有效的接口配置（可能地址写错了）'; return result; }

      // 多仓：{urls:[...]}
      if (data && typeof data === 'object' && !(data instanceof Array)
          && data.urls instanceof Array) {
        result.name = data.name || '';
        if (depth >= 2) { result.error = '多仓层级过深'; return result; }
        var subs = data.urls.slice(0, 6).map(function (u) {
          if (u && typeof u === 'object') u = u.url || '';
          return fetchConfig(u, depth + 1);
        });
        return pool(subs, 3, function (p) { return p; }).then(function (list) {
          list.forEach(function (sub) {
            if (sub && sub.ok) {
              result.children.push(sub);
              result.sites = result.sites.concat(sub.sites);
            }
          });
          result.ok = result.sites.length > 0;
          if (!result.ok) result.error = '多仓里所有子配置都拉取失败';
          return result;
        });
      }

      result.sites = extractSites(data, _srcId(url), url);
      result.parses = extractParses(data);
      result.name = (data && !(data instanceof Array) && data.name) ? data.name : '';
      result.ok = result.sites.length > 0;
      if (!result.ok) result.error = '配置里没有可用站点（可能是空壳配置）';
      return result;
    });
  }

  /* ------------------------------------------------ 站点/列表/搜索/热门 */

  function sitesPayload() {
    var out = usableSites().map(function (s) {
      return {
        key: s.key, name: s.name, source: s.sourceName,
        searchable: s.searchable, spider: !!s.spider,
        api: s.api, cats: catsCacheGet(s.key) || []
      };
    });
    return { ok: true, sites: out };
  }

  function categoriesPayload(key) {
    var site = siteByKey(key);
    if (!site) return Promise.resolve({ ok: false, error: '站点不存在' });
    return fetchCats(key).then(function (rows) {
      return { ok: true, list: catsUsable(rows) };
    });
  }

  function listPayload(params) {
    var key = params.site;
    var tid = String(params.type || '');
    var page = String(params.page || '1');
    var site = siteByKey(key);
    if (!site) return Promise.resolve({ ok: false, error: '站点不存在' });
    var pg = parseInt(page, 10) || 1;

    function one(t) {
      var p = { ac: 'detail', pg: page };
      if (t) p.t = t;
      return callVod(site, p).then(function (d) {
        return parseVideos(d);
      }).catch(function () { return []; });
    }

    function pack(list) {
      return { ok: true, list: list, page: pg, hasMore: list.length > 0 };
    }

    if (!tid) return one('').then(pack);

    // 一级分类（如「电影」）自己往往一个片都没有，内容全挂在子分类下；
    // 虚拟大类 g1..g6 同理。所以先把该分类及其全部子分类展开，
    // 只有一个就直取，多于一个就并发聚合（与电脑端索引路径 cat_descendants 行为一致）。
    return fetchCats(key).then(function (rows) {
      var tids = catDescendants(rows, key, tid).slice(0, 8);
      if (!tids.length) tids = [tid];
      if (tids.length === 1) return one(tids[0]).then(pack);
      return pool(tids.map(one), CONCURRENCY, function (p) { return p; }).then(function (arrs) {
        var seen = {}, uniq = [];
        arrs.forEach(function (vids) {
          (vids || []).forEach(function (v) {
            if (seen[v.id]) return;
            seen[v.id] = 1;
            uniq.push(v);
          });
        });
        return pack(uniq);
      });
    });
  }

  /* ------------------------------------------------ 跨源聚合（以片为主）

     以前要先选影视源再看片单，用户得先理解「源」这个概念。现在把各源片单
     合并成一份，同一部片只出一张卡；点进去先看视频，视频下面再列线路。
     手机端没有预索引，只能现场并发抓取，所以合并的源比电脑端少几个，
     并且把结果缓存几分钟，避免来回切页面反复抓。 */

  var FEED_SITES_MAX = 4;
  var FEED_PAGE_SIZE = 12;
  var FEED_MAX_ITEMS = 60;
  var FEED_TTL = 5 * 60 * 1000;
  var LS_FEED = 'dxk.feed.';
  var _feedCats = { t: 0, data: null };
  // 各源叫法不一：暴风叫「短剧大全」、360 叫「爽文短剧」、其余叫「短剧」，
  // 合并后统一收拢成一个「短剧」，否则一级菜单会冒出三个重复项
  var FEED_TOP_FOLD = ['短剧'];

  function topName(name) {
    var n = String(name || '').trim();
    for (var i = 0; i < FEED_TOP_FOLD.length; i++) {
      if (n.indexOf(FEED_TOP_FOLD[i]) >= 0) return FEED_TOP_FOLD[i];
    }
    return n;
  }

  function feedSites(limit) {
    var dead = deadKeys();
    return allSites().filter(function (s) {
      return String(s.api || '').indexOf('http') === 0 && !s.spider &&
        dead.indexOf(s.key) < 0;
    }).slice(0, limit || FEED_SITES_MAX);
  }

  function feedCatsPayload() {
    if (_feedCats.data && Date.now() - _feedCats.t < FEED_TTL) {
      return Promise.resolve(_feedCats.data);
    }
    // 拿不到就退回上一次的（可能过期），别让分类页空掉
    function stale() {
      return _feedCats.data || { ok: true, list: [], sites: [] };
    }
    var sites = feedSites();
    return pool(sites, CONCURRENCY, function (s) {
      return fetchCats(s.key).then(function (rows) { return { site: s, rows: rows }; },
        function () { return { site: s, rows: [] }; });
    }).then(function (arr) {
      var tops = {}, seen = {}, order = [];
      (arr || []).forEach(function (it) {
        if (!it) return;
        var usable = catsUsable(it.rows || []);
        var kids = {};
        usable.forEach(function (c) {
          var p = String(c.pid || '0');
          (kids[p] = kids[p] || []).push(c);
        });
        usable.forEach(function (c) {
          if (String(c.pid || '0') !== '0') return;
          var name = topName(c.name);
          if (!name) return;
          if (!tops[name]) {
            tops[name] = { id: name, name: name, kids: [] };
            seen[name] = {};
            order.push(name);
          }
          (kids[String(c.id)] || []).forEach(function (k) {
            var kn = String(k.name || '').trim();
            if (kn && !seen[name][kn]) {
              seen[name][kn] = 1;
              tops[name].kids.push({ id: kn, name: kn });
            }
          });
        });
      });
      order.sort(function (a, b) {
        var ia = a === '其他' ? 99 : CAT_ORDER.indexOf(a),   // 兜底分类永远排最后
            ib = b === '其他' ? 99 : CAT_ORDER.indexOf(b);
        if (ia < 0) ia = CAT_ORDER.length;
        if (ib < 0) ib = CAT_ORDER.length;
        if (ia !== ib) return ia - ib;
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      var data = {
        ok: true,
        list: order.map(function (n) { return tops[n]; }),
        sites: sites.map(function (s) { return { key: s.key, name: s.name }; })
      };
      if (!data.list.length) return stale();
      _feedCats.t = Date.now();
      _feedCats.data = data;
      return data;
    }, function () { return stale(); });
  }

  /* 统一分类名 → 某源自己的分类 id（虚拟大类 g1..g6 也能展开） */
  function feedTid(rows, cat, sub) {
    var usable = catsUsable(rows || []);
    var top = null, i;
    for (i = 0; i < usable.length; i++) {
      // 名字按 topName 归并后再比：源叫「短剧大全」也能对上前端的「短剧」
      if (String(usable[i].pid || '0') === '0' && topName(usable[i].name) === cat) {
        top = usable[i];
        break;
      }
    }
    if (!top) return null;
    if (!sub) return String(top.id);
    for (i = 0; i < usable.length; i++) {
      if (String(usable[i].pid) === String(top.id) &&
          String(usable[i].name || '').trim() === sub) {
        return String(usable[i].id);
      }
    }
    return null;
  }

  function feedLive(site, rows, tid, page, size) {
    var tids = tid ? (catDescendants(rows, site.key, tid) || [tid]).slice(0, 4) : [''];
    function one(t) {
      var p = { ac: 'videolist', pg: page };
      if (t) p.t = t;
      return callVod(site, p, 12000).then(function (d) { return parseVideos(d); },
        function () { return []; });
    }
    if (tids.length === 1) {
      return one(tids[0]).then(function (v) { return v.slice(0, size); });
    }
    return pool(tids, CONCURRENCY, one).then(function (arrs) {
      var seen = {}, out = [];
      (arrs || []).forEach(function (arr) {
        (arr || []).forEach(function (v) {
          if (!v.id || seen[v.id]) return;
          seen[v.id] = 1;
          out.push(v);
        });
      });
      return out.slice(0, size);
    });
  }

  /* 各源片单合并：同名影片合成一条，cands 里记着各源的线路 */
  function mergeFeed(groups) {
    var order = [], m = {};
    groups.forEach(function (g) {
      (g.list || []).forEach(function (v) {
        var k = normFeedName(v.name);
        if (!k) return;
        var it = m[k];
        if (!it) {
          it = { name: v.name, pic: v.pic || '', remarks: v.remarks || '',
                 year: v.year || '', cands: [] };
          m[k] = it;
          order.push(k);
        }
        if (!it.pic && v.pic) it.pic = v.pic;
        if (!it.remarks && v.remarks) it.remarks = v.remarks;
        if (!it.year && v.year) it.year = v.year;
        it.cands.push({
          site: g.site, siteName: g.siteName, source: g.source, id: v.id,
          name: v.name, pic: v.pic || '', remarks: v.remarks || '',
          year: v.year || '', type: v.type || '', score: v.score || ''
        });
      });
    });
    return order.map(function (k) {
      var it = m[k], c0 = it.cands[0];
      it.srcCount = it.cands.length;
      it.id = c0.id;
      it.site = c0.site;
      it.type = c0.type || '';
      it.score = c0.score || '';
      return it;
    }).slice(0, FEED_MAX_ITEMS);
  }

  function normFeedName(n) {
    return String(n || '')
      .replace(/[\s·・:：\-—_()（）\[\]【】《》"'“”'']/g, '')
      .toLowerCase();
  }

  function feedPayload(params) {
    var cat = String(params.cat || '').trim();
    var sub = String(params.sub || '').trim();
    var page = parseInt(params.page, 10) || 1;
    if (!cat) sub = '';
    var ck = LS_FEED + cat + '|' + sub + '|' + page;
    var cached = lsGet(ck, null);
    if (cached && cached.t && Date.now() - cached.t < FEED_TTL) {
      return Promise.resolve(cached.d);
    }
    // 全断了就退回上次的片单（可能过期），保证断网时还有内容可翻
    function stale() {
      return (cached && cached.d && cached.d.ok) ? cached.d
        : { ok: true, list: [], page: page, hasMore: false, indexed: null, total: 0 };
    }
    var sites = feedSites();
    return pool(sites, CONCURRENCY, function (s) {
      return fetchCats(s.key).then(function (rows) { return { site: s, rows: rows }; },
        function () { return { site: s, rows: [] }; });
    }).then(function (arr) {
      var jobs = [];
      (arr || []).forEach(function (it) {
        if (!it) return;
        var tid = null;
        if (cat) {
          tid = feedTid(it.rows, cat, sub);
          if (!tid) return;
        }
        jobs.push(function () {
          return feedLive(it.site, it.rows, tid, page, FEED_PAGE_SIZE).then(function (vids) {
            if (!vids.length) return null;
            return { site: it.site.key, siteName: it.site.name,
                     source: it.site.sourceName, list: vids };
          }, function () { return null; });
        });
      });
      return pool(jobs, CONCURRENCY, function (f) { return f(); });
    }).then(function (groups) {
      groups = (groups || []).filter(function (g) { return !!g; });
      if (!groups.length) return stale();      // 一个源都没回来：多半是断网
      var data = {
        ok: true, list: mergeFeed(groups), page: page,
        hasMore: groups.some(function (g) { return g.list.length >= FEED_PAGE_SIZE; }),
        indexed: null, total: groups.length
      };
      lsSet(ck, { t: Date.now(), d: data });
      return data;
    }, function () { return stale(); });
  }

  function detailPayload(params) {
    var site = siteByKey(params.site);
    if (!site) return Promise.resolve({ ok: false, error: '站点不存在' });
    return callVod(site, { ac: 'detail', ids: String(params.id || '') }).then(function (data) {
      var info = parseDetail(data);
      if (!info) return { ok: false, error: '获取详情失败' };
      return { ok: true, detail: info };
    });
  }

  function searchPayload(params) {
    var wd = String(params.wd || '').trim();
    if (!wd) return Promise.resolve({ ok: false, error: '请输入关键词' });
    var keys = String(params.sites || '').split(',').filter(function (k) { return !!k; });
    var sites = usableSites();
    if (keys.length) sites = sites.filter(function (s) { return keys.indexOf(s.key) >= 0; });
    else sites = sites.filter(function (s) { return s.searchable && !s.spider; });
    sites = sites.slice(0, 25);

    var jobs = sites.map(function (s) {
      return callVod(s, { ac: 'detail', wd: wd, pg: '1' }, NET_TIMEOUT).then(function (data) {
        var vids = parseVideos(data);
        if (!vids.length) return null;
        return { site: s.key, siteName: s.name, source: s.sourceName, list: vids.slice(0, 40) };
      }).catch(function () { return null; });
    });
    return pool(jobs, CONCURRENCY, function (p) { return p; }).then(function (list) {
      var groups = (list || []).filter(function (g) { return !!g; });
      groups.sort(function (a, b) { return b.list.length - a.list.length; });
      var total = groups.reduce(function (n, g) { return n + g.list.length; }, 0);
      return { ok: true, groups: groups, total: total };
    });
  }

  function searchSitePayload(params) {
    var key = params.site;
    var wd = String(params.wd || '').trim();
    var page = String(params.page || '1');
    var site = siteByKey(key);
    if (!site) return Promise.resolve({ ok: false, error: '站点不存在' });
    return callVod(site, { ac: 'detail', wd: wd, pg: page }, NET_TIMEOUT).then(function (data) {
      return { ok: true, list: parseVideos(data), page: parseInt(page, 10) || 1 };
    });
  }

  /* 手机端没有预索引，热门词取几个源的首页最新剧名合并 */
  function hotPayload(params) {
    var n = parseInt(params.limit, 10);
    if (!n || n <= 0) n = 24;
    var sites = usableSites().slice(0, 4);
    var jobs = sites.map(function (s) {
      return callVod(s, { ac: 'detail', pg: '1' }).then(function (d) {
        return parseVideos(d);
      }).catch(function () { return []; });
    });
    return pool(jobs, CONCURRENCY, function (p) { return p; }).then(function (arrs) {
      var seen = {}, out = [];
      arrs.forEach(function (vids) {
        (vids || []).forEach(function (v) {
          if (!v.name || seen[v.name]) return;
          seen[v.name] = 1;
          out.push(v.name);
        });
      });
      return { ok: true, list: out.slice(0, n) };
    });
  }

  /* ------------------------------------------------ 简易网页嗅探（对应 server.py 的 sniff_from_html）
     有些源给的是一条分享页地址而不是 m3u8 直链，这时把页面取回来找真正的播放地址。 */

  var RE_URL_IN_TEXT = /(?:https?:)?\/\/[^\s'"\\<>()]+?\.(?:m3u8|mp4|flv|mkv)(?:\?[^\s'"\\<>()]*)?/i;
  var RE_QUOTED_MEDIA = /["']([^"'\s]{2,300}?\.(?:m3u8|mp4|flv|mkv)(?:\?[^"'\s]*)?)["']/i;

  function resolveUrl(base, rel) {
    if (/^[a-z]+:\/\//i.test(rel)) return rel;
    var m = String(base || '').match(/^([a-z]+:\/\/[^\/]+)(\/[^?#]*)?/i);
    if (!m) return rel;
    if (rel.charAt(0) === '/') return m[1] + rel;
    var path = m[2] || '/';
    return m[1] + path.replace(/[^\/]*$/, '') + rel;
  }

  function sniffFromHtml(text, base) {
    if (!text) return '';
    var hosts = '';
    var mh = text.match(/var\s+hosts\s*=\s*["']([^"']+)["']/);
    if (mh) hosts = mh[1].trim();

    function absolute(v) {
      v = cleanUrl(v).replace(/\\\//g, '/').trim();
      if (!v) return '';
      if (v.indexOf('//') === 0) return 'https:' + v;
      if (v.indexOf('http') === 0) return v;
      if (v.charAt(0) === '/' && hosts.indexOf('http') === 0) return hosts.replace(/\/+$/, '') + v;
      if (base) return resolveUrl(base, v);
      return v;
    }

    // 1) 苹果CMS 播放器变量  player_aaaa = {...}
    var m = text.match(/player_\w+\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
    if (m) {
      var j = safeJson(m[1]);
      if (j && j.url) return absolute(String(j.url));
    }
    // 2) 形如 "url":"xxx" / "video":"xxx" 的字段
    var pats = [/"url"\s*:\s*"([^"]{6,})"/i, /'url'\s*:\s*'([^']{6,})'/i,
      /"(?:video|source|src|playUrl|play_url|main|m3u8)"\s*:\s*"([^"]{6,})"/i];
    for (var i = 0; i < pats.length; i++) {
      var mm = text.match(pats[i]);
      if (mm) {
        var v = absolute(mm[1]);
        if (v && (looksPlayable(v) || /\.m3u8|\.mp4/i.test(v))) return v;
      }
    }
    // 3) 引号里的 .m3u8 路径
    var mq = text.match(RE_QUOTED_MEDIA);
    if (mq) { var v3 = absolute(mq[1]); if (v3) return v3; }
    // 4) 裸链接
    var mu = text.match(RE_URL_IN_TEXT);
    if (mu) return absolute(mu[0]);
    return '';
  }

  /* 播放：手机端没有服务端解析。直链原样返回；明显不是直链的页面才试着嗅探一下 */
  function playPayload(params) {
    var raw = cleanUrl(params.url || '');
    if (!raw) return Promise.resolve({ ok: false, error: '地址为空' });
    if (looksPlayable(raw)) {
      return Promise.resolve({ ok: true, url: raw, play: raw, how: '直链' });
    }
    return httpGet(raw, { 'Referer': raw }, NET_TIMEOUT).then(function (text) {
      var found = sniffFromHtml(text, raw);
      if (found) return { ok: true, url: found, play: found, how: '网页嗅探' };
      return { ok: true, url: raw, play: raw, how: '手机直连' };
    });
  }

  /* 自定义地址：手机端没有代理，网络地址原样交给播放器直连；
     本机缓存的文件已经转成 WebView 能读的地址，直接播；
     电脑上的本地文件手机读不到，给一句能看懂的话。 */
  function customPayload(params) {
    var raw = cleanUrl(params.url || '');
    if (!raw) return Promise.resolve({ ok: false, error: '地址为空' });
    // 本机缓存文件：Capacitor.convertFileSrc 出来的地址
    if (/(_capacitor_file_|_capacitor_content_)/i.test(raw)) {
      return Promise.resolve({ ok: true, url: raw, play: raw, how: '本机缓存' });
    }
    if (/^file:\/\//i.test(raw) || /^[a-zA-Z]:[\\\/]/.test(raw)) {
      return Promise.resolve({
        ok: false,
        error: '手机版放不了电脑上的本地文件。想放本地文件，请先在「我的 → 手机 / 平板连接」里连上电脑。'
      });
    }
    return Promise.resolve({ ok: true, url: raw, play: raw, how: '自定义地址' });
  }

  /* ------------------------------------------------ 直播源（对应 server.py 的 parse_m3u） */

  function parseM3u(text, baseUrl) {
    var out = [], cur = null, i, line, u, seg;
    var upper = String(text).toUpperCase();
    var isPls = upper.indexOf('#EXTM3U') >= 0 && upper.indexOf('#EXTINF') >= 0;
    var lines = String(text).split(/\r?\n/);
    for (i = 0; i < lines.length; i++) {
      line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXTINF') === 0) {
        var pos = line.indexOf(',');
        var name = pos >= 0 ? line.slice(pos + 1).trim() : '';
        var mg = line.match(/group-title="([^"]*)"/);
        var ml = line.match(/tvg-logo="([^"]*)"/);
        cur = { name: name || '未命名', group: mg ? mg[1] : '', logo: ml ? ml[1] : '', url: '' };
      } else if (line.charAt(0) === '#') {
        continue;
      } else {
        u = resolveUrl(baseUrl, line);
        if (cur) {
          cur.url = u;
          if (u) out.push(cur);
          cur = null;
        } else if (isPls || looksPlayable(u)) {
          seg = u.split('/');
          out.push({ name: (seg[seg.length - 1] || '').slice(0, 40), group: '', logo: '', url: u });
        }
      }
    }
    return out;
  }

  function livePayload(params) {
    var raw = cleanUrl(params.url || '');
    if (!raw) return Promise.resolve({ ok: false, error: '地址为空' });
    return httpGet(raw, { 'Referer': raw }, 20000).then(function (text) {
      if (!text || !String(text).trim()) return { ok: false, error: '无法获取直播列表' };
      var list = parseM3u(text, raw);
      return { ok: true, list: list, count: list.length };
    });
  }

  /* ------------------------------------------------ 收藏 / 历史 / 进度 */

  function favList() {
    var f = lsGet(LS_FAV, []);
    return (f instanceof Array) ? f : [];
  }

  function hisList() {
    var h = lsGet(LS_HIS, []);
    return (h instanceof Array) ? h : [];
  }

  function progMap() {
    var p = lsGet(LS_PROG, {});
    return (p && typeof p === 'object' && !(p instanceof Array)) ? p : {};
  }

  /* 历史记录归并用的键：同一部片子来自不同影视源时，按片名归一。
     归一规则要和首页「继续观看」用的 normName 一致（空格 + 标点一起去掉），
     否则同一部片在这两处会出现「历史里还有两条、继续观看只剩一条」。 */
  function hisKey(v) {
    var n = String((v && v.name) || '')
      .replace(/[\s·・:：\-—_()（）\[\]【】《》"'“”‘’]+/g, '')
      .toLowerCase();
    return n || ('#k#' + String((v && v.key) || ''));
  }

  function favoriteHandler(post) {
    var body = post || {};
    var item = body.video || {};
    var act = body.action || '';
    var list = favList();
    if (act === 'clear') {
      lsSet(LS_FAV, []);
      return { ok: true, cleared: true };
    }
    if (act === 'remove') {
      var keys = (body.keys || []).filter(function (k) { return k !== null && k !== undefined; });
      var before = list.length;
      var next = list.filter(function (x) { return keys.indexOf(x.key) < 0; });
      lsSet(LS_FAV, next);
      return { ok: true, removed: before - next.length };
    }
    if (!item.key) return { ok: false, error: '缺少参数' };
    var exists = list.some(function (x) { return x.key === item.key; });
    if (exists) next = list.filter(function (x) { return x.key !== item.key; });
    else { next = list.slice(); next.unshift(item); }
    lsSet(LS_FAV, next);
    return { ok: true, added: !exists };
  }

  function historyHandler(post, params) {
    var body = post || {};
    var list = hisList();
    var act = body.action || '';
    if (act === 'clear') {
      lsSet(LS_HIS, []);
      return { ok: true, cleared: true };
    }
    if (act === 'remove') {
      var keys = (body.keys || []).filter(function (k) { return k !== null && k !== undefined; });
      var before = list.length;
      var next = list.filter(function (x) { return keys.indexOf(x.key) < 0; });
      lsSet(LS_HIS, next);
      return { ok: true, removed: before - next.length };
    }
    var hasVideo = !!(body && body.video);
    if (!hasVideo) {
      return { ok: true, list: list.slice(0, 60) };
    }
    var item = body.video;
    var nk = hisKey(item);
    // 同一部片子换了影视源也只留一条，避免历史里出现两条一样的
    var kept = list.filter(function (x) {
      return x.key !== item.key && hisKey(x) !== nk;
    });
    kept.unshift(item);
    lsSet(LS_HIS, kept.slice(0, 60));
    return { ok: true };
  }

  function progressHandler(post, params) {
    var p = post || {};
    var prog = progMap();
    if (p.key) {
      var rec = {};
      var old = prog[p.key] || {};
      Object.keys(old).forEach(function (k) { rec[k] = old[k]; });
      Object.keys(p).forEach(function (k) { if (k !== 'key') rec[k] = p[k]; });
      rec.key = p.key;
      rec.time = Date.now();
      prog[p.key] = rec;
      var keys = Object.keys(prog);
      if (keys.length > 300) {   // 只留最近 300 部
        var keep = keys.map(function (k) { return prog[k]; })
          .sort(function (a, b) { return (b.time || 0) - (a.time || 0); })
          .slice(0, 300);
        var m = {};
        keep.forEach(function (x) { m[x.key] = x; });
        prog = m;
      }
      lsSet(LS_PROG, prog);
      return { ok: true, progress: rec };
    }
    var key = (params && params.key) || '';
    if (key) return { ok: true, progress: prog[key] || {} };
    return { ok: true, progress: prog };
  }

  /* ------------------------------------------------ 源管理 */

  function statePayload() {
    var sources = loadSources().map(function (s) {
      return {
        id: s.id, name: s.name, url: s.url,
        enabled: s.enabled !== false,
        siteCount: (s.sites || []).length,
        parseCount: (s.parses || []).length,
        addedAt: s.addedAt || 0,
        builtin: !!s.builtin
      };
    });
    return {
      ok: true, sources: sources, presets: [],
      siteCount: usableSites().length,
      history: hisList().slice(0, 30),
      favorites: favList(),
      progress: progMap()
    };
  }

  function sourceTest(post) {
    var url = cleanUrl((post && post.url) || '');
    return fetchConfig(url, 0, (post && post.name) || '').then(function (r) {
      return {
        ok: r.ok, error: r.error, name: r.name || '',
        siteCount: (r.sites || []).length,
        parseCount: (r.parses || []).length,
        samples: (r.sites || []).slice(0, 12).map(function (s) { return s.name; })
      };
    });
  }

  function sourceAdd(post) {
    var url = cleanUrl((post && post.url) || '');
    var name = String((post && post.name) || '').trim();
    if (!url) return Promise.resolve({ ok: false, error: '请填写接口地址' });
    return fetchConfig(url, 0, name).then(function (r) {
      if (!r.ok) return { ok: false, error: r.error || '订阅失败' };
      var sid = _srcId(url);
      var list = loadSources().filter(function (s) { return s.id !== sid; });
      list.push({
        id: sid,
        name: name || r.name || (url.match(/^[a-z]+:\/\/([^\/]+)/i) || [])[1] || '未命名源',
        url: url, enabled: true, addedAt: Date.now(),
        sites: r.sites, parses: r.parses
      });
      saveSources(list);
      return { ok: true, id: sid, siteCount: r.sites.length, parseCount: r.parses.length };
    });
  }

  function sourceRemove(post) {
    var sid = (post && post.id) || '';
    if (sid === BUILTIN_ID) return Promise.resolve({ ok: false, error: '内置源不可删除' });
    var list = loadSources();
    if (!list.some(function (s) { return s.id === sid; })) {
      return Promise.resolve({ ok: false, error: '源不存在' });
    }
    saveSources(list.filter(function (s) { return s.id !== sid; }));
    return Promise.resolve({ ok: true });
  }

  function sourceToggle(post) {
    var sid = (post && post.id) || '';
    var list = loadSources();
    var hit = false;
    list.forEach(function (s) {
      if (s.id === sid) { s.enabled = s.enabled === false; hit = true; }
    });
    if (!hit) return Promise.resolve({ ok: false, error: '源不存在' });
    saveSources(list);
    return Promise.resolve({ ok: true });
  }

  function sourceMove(post) {
    var sid = (post && post.id) || '';
    var to = parseInt((post && post.to), 10);
    var list = loadSources().filter(function (s) { return !s.builtin; });
    var from = -1, i;
    for (i = 0; i < list.length; i++) { if (list[i].id === sid) { from = i; break; } }
    if (from < 0 || isNaN(to)) return Promise.resolve({ ok: false, error: '源不存在' });
    var one = list.splice(from, 1)[0];
    to = Math.max(0, Math.min(to, list.length));
    list.splice(to, 0, one);
    var all = loadSources().filter(function (s) { return s.builtin; }).concat(list);
    saveSources(all);
    return Promise.resolve({ ok: true });
  }

  /* 更新：内置源逐个验证剔除失效站点，自建源重新拉配置 */
  function sourceRefresh(post) {
    var sid = (post && post.id) || '';
    var list = loadSources();
    var src = null;
    for (var i = 0; i < list.length; i++) { if (list[i].id === sid) { src = list[i]; break; } }
    if (!src) return Promise.resolve({ ok: false, error: '源不存在' });

    if (src.builtin) {
      var dead = [];
      var jobs = (src.sites || []).map(function (s) {
        return cmsApiToSite(s.api, s.name).then(function (ok) { return ok ? s : null; });
      });
      return pool(jobs, CONCURRENCY, function (p) { return p; }).then(function (res) {
        var alive = res.filter(function (s) { return !!s; });
        (src.sites || []).forEach(function (s) {
          var ok = alive.some(function (x) { return x.key === s.key; });
          if (!ok && dead.indexOf(s.key) < 0) dead.push(s.key);
        });
        lsSet(LS_DEAD, dead);
        return { ok: true, siteCount: alive.length, removed: (src.sites || []).length - alive.length };
      });
    }

    return fetchConfig(src.url, 0, src.name).then(function (r) {
      if (!r.ok) return { ok: false, error: r.error };
      src.sites = r.sites;
      src.parses = r.parses;
      saveSources(list);
      return { ok: true, siteCount: r.sites.length };
    });
  }

  /* ------------------------------------------------ 手机端网络兜底：接管 XHR

     hls.min.js 默认用 XMLHttpRequest 去拉 m3u8 和 ts 切片。WebView 里跨域 XHR 会被
     CORS 拦掉（切片服务器基本不带 CORS 头），画面直接卡住。Capacitor 的原生 HTTP
     不受 CORS 限制，所以本地模式把 XHR 接到原生通道上。
     只在「手机 App 且没连电脑」时安装，电脑端、连电脑的手机端都不受影响。 */

  function installNativeXhr() {
    if (window.__dxkXhrInstalled) return;
    var cap = capHttp();
    if (!cap || (!cap.request && !cap.get)) return;
    var Native = window.XMLHttpRequest;
    if (!Native) return;
    window.__dxkXhrInstalled = true;

    // 只接 http(s) 的外网地址；本机地址、电脑地址交回系统原生 XHR
    function isRemote(url) {
      if (!/^https?:\/\//i.test(url)) return false;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([\/?#]|$)/i.test(url)) return false;
      var srv = '';
      try { srv = String(localStorage.getItem('dxk.server') || ''); } catch (e) {}
      var sm = srv.match(/^https?:\/\/([^\/]+)/i);
      if (sm) {
        var um = url.match(/^https?:\/\/([^\/]+)/i);
        if (um && um[1].toLowerCase() === sm[1].toLowerCase()) return false;
      }
      return true;
    }

    function toBuffer(d) {
      if (!d) return new ArrayBuffer(0);
      if (typeof ArrayBuffer !== 'undefined' && d instanceof ArrayBuffer) return d;
      if (typeof d === 'string') {
        try {
          var b64 = d.indexOf('base64,') >= 0 ? d.split('base64,')[1] : d;
          var bin = atob(b64), n = bin.length, buf = new Uint8Array(n);
          for (var i = 0; i < n; i++) buf[i] = bin.charCodeAt(i);
          return buf.buffer;
        } catch (e) { return new ArrayBuffer(0); }
      }
      return new ArrayBuffer(0);
    }

    function Shim() {
      if (!(this instanceof Shim)) return new Shim();
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.response = '';
      this.responseText = '';
      this.responseType = '';
      this.responseURL = '';
      this.timeout = 0;
      this.withCredentials = false;
      this._h = {}; this._rh = {}; this._ls = {};
      this._native = false; this._real = null; this._aborted = false;
    }

    Shim.prototype.open = function (method, url) {
      this._method = String(method || 'GET').toUpperCase();
      this._url = String(url || '');
      this.responseURL = this._url;
      this._native = isRemote(this._url);
      this.readyState = 1;
      this._fire('readystatechange');
    };
    Shim.prototype.setRequestHeader = function (k, v) { this._h[k] = v; };
    Shim.prototype.getResponseHeader = function (k) {
      var lk = String(k).toLowerCase(), key;
      for (key in this._rh) if (key.toLowerCase() === lk) return this._rh[key];
      return null;
    };
    Shim.prototype.getAllResponseHeaders = function () {
      var self = this;
      return Object.keys(this._rh).map(function (k) { return k + ': ' + self._rh[k]; }).join('\r\n');
    };
    Shim.prototype.addEventListener = function (t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); };
    Shim.prototype.removeEventListener = function (t, fn) {
      var a = this._ls[t]; if (!a) return;
      var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    };
    Shim.prototype.abort = function () {
      this._aborted = true;
      if (this._real) { try { this._real.abort(); } catch (e) {} }
      this.readyState = 0;
      this._fire('abort');
      this._fire('loadend');
    };
    Shim.prototype._fire = function (t, ev) {
      ev = ev || { type: t, target: this, currentTarget: this };
      var h = this['on' + t];
      if (typeof h === 'function') { try { h.call(this, ev); } catch (e) {} }
      var a = this._ls[t];
      if (a) a.slice().forEach(function (fn) { try { fn.call(this, ev); } catch (e) {} });
    };
    Shim.prototype.send = function (body) {
      var self = this;

      // 站内 / 本机地址：照常走系统原生 XHR
      if (!this._native) {
        var x = new Native();
        x.open(this._method, this._url, true);
        if (this.responseType) { try { x.responseType = this.responseType; } catch (e) {} }
        Object.keys(this._h).forEach(function (k) {
          try { x.setRequestHeader(k, self._h[k]); } catch (e) {}
        });
        x.onreadystatechange = function () {
          self.readyState = x.readyState;
          if (x.readyState === 4) {
            self.status = x.status; self.statusText = x.statusText;
            self.response = x.response; self.responseText = x.responseText;
          }
          self._fire('readystatechange');
        };
        x.onload = function () { self._fire('load'); };
        x.onerror = function () { self._fire('error'); };
        x.ontimeout = function () { self._fire('timeout'); };
        x.onabort = function () { self._fire('abort'); };
        this._real = x;
        try { x.send(body); } catch (e) { self._fire('error'); }
        return;
      }

      // 外网地址：走原生 HTTP（绕开 CORS）
      var isBuf = (this.responseType === 'arraybuffer' || this.responseType === 'blob');
      var req = {
        url: this._url,
        method: this._method,
        headers: this._h,
        responseType: isBuf ? 'arraybuffer' : 'text',
        connectTimeout: 15000,
        readTimeout: this.timeout > 0 ? this.timeout : 30000
      };
      if (body && this._method !== 'GET' && this._method !== 'HEAD') req.data = body;

      var done = false, timer = null;
      if (this.timeout > 0) {
        timer = setTimeout(function () {
          if (done) return; done = true;
          self.readyState = 4;
          self._fire('readystatechange');
          self._fire('timeout');
          self._fire('loadend');
        }, this.timeout);
      }
      function finish() { if (timer) clearTimeout(timer); done = true; }
      function settle(res) {
        if (done || self._aborted) return;
        finish();
        self.readyState = 4;
        self.status = (res && res.status) || 0;
        self.statusText = self.status ? String(self.status) : '';
        self._rh = (res && res.headers) || {};
        var data = res && res.data;
        if (isBuf) {
          self.response = toBuffer(data);
          self.responseText = '';
        } else {
          var txt = (data === null || data === undefined) ? ''
                  : (typeof data === 'string' ? data : JSON.stringify(data));
          self.response = txt; self.responseText = txt;
        }
        self._fire('readystatechange');
        self._fire('load');
        self._fire('loadend');
      }
      function fail() {
        if (done || self._aborted) return;
        finish();
        self.readyState = 4;
        self.status = 0; self.statusText = '';
        self._fire('readystatechange');
        self._fire('error');
        self._fire('loadend');
      }

      try {
        var pr = cap.request ? cap.request(req)
          : cap.get({ url: req.url, headers: req.headers, responseType: req.responseType,
                      connectTimeout: req.connectTimeout, readTimeout: req.readTimeout });
        if (pr && pr.then) pr.then(settle, fail); else fail();
      } catch (e) { fail(); }
    };

    window.XMLHttpRequest = Shim;
  }

  /* ------------------------------------------------ 离线缓存（手机端本机存储）

     手机上没有 Python 后端，缓存直接写进 App 私有目录（Directory.Data），
     Android 10+ 免存储权限。整文件（mp4/flv）按 Range 分片续传；m3u8 把 TS
     分片按顺序拼成一个 .ts（TS 是自同步流，顺序拼接即为合法可播文件）。
     任务表存 localStorage，播放时把文件地址转成 WebView 能读的地址。 */

  var LS_DL = 'dxk.dl';
  var DL_DIRNAME = 'dl';
  var DL_CONC = 2;                    // 同时缓存 2 集：上游对高频请求敏感
  var DL_CHUNK = 2 * 1024 * 1024;     // 整文件分片 2MB

  var dlActive = {};                  // 本次运行中正在下 / 排队的 id
  var dlQueue = [];
  var dlRun = 0;

  function fsPlugin() {
    var c = window.Capacitor;
    return (c && c.Plugins && c.Plugins.Filesystem) || null;
  }

  function dlSafe(name) {
    var s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/^[ ._]+|[ ._]+$/g, '');
    return (s || '未命名').slice(0, 60);
  }

  function dlGroupId(name, key) {
    return md5hex(String(name || '') + '|' + String(key || '')).slice(0, 12);
  }

  function dlTable() {
    var a = lsGet(LS_DL, []);
    return (a instanceof Array) ? a : [];
  }

  function dlSaveTable(a) { lsSet(LS_DL, a); }

  function dlFind(id) {
    var a = dlTable();
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }

  function dlSet(id, patch) {
    var a = dlTable(), i, k;
    for (i = 0; i < a.length; i++) {
      if (a[i].id === id) { for (k in patch) a[i][k] = patch[k]; break; }
    }
    dlSaveTable(a);
  }

  /* 上次没下完的算「已中断」，可以点「继续」续传（本次正在下的不动） */
  function dlNormalize() {
    var a = dlTable(), ch = false;
    for (var i = 0; i < a.length; i++) {
      var it = a[i];
      if (dlActive[it.id]) continue;
      if (it.state === '下载中' || it.state === '排队中' || it.state === '等待中') {
        it.state = '已中断';
        ch = true;
      }
    }
    if (ch) dlSaveTable(a);
    return a;
  }

  /* ---- Filesystem：写 / 删 / 取真实地址 / 查大小（文件走 base64，二进制） ---- */

  function fsWrite(path, b64, append) {
    var fs = fsPlugin();
    if (!fs) return Promise.reject(new Error('本机文件插件未安装'));
    var opt = { path: path, data: b64, directory: 'DATA', recursive: true };
    if (append && fs.appendFile) return fs.appendFile(opt);
    return fs.writeFile(opt);
  }

  function fsDelete(path) {
    var fs = fsPlugin();
    if (!fs) return Promise.resolve(false);
    return fs.deleteFile({ path: path, directory: 'DATA' })
      .then(function () { return true; }, function () { return false; });
  }

  function fsStat(path) {
    var fs = fsPlugin();
    if (!fs) return Promise.resolve(null);
    return fs.stat({ path: path, directory: 'DATA' })
      .then(function (r) { return (r && typeof r.size === 'number') ? r : null; },
            function () { return null; });
  }

  function fsPlayUrl(path) {
    var fs = fsPlugin();
    if (!fs) return Promise.resolve('');
    return fs.getUri({ path: path, directory: 'DATA' }).then(function (r) {
      var uri = (r && r.uri) || '';
      var c = window.Capacitor;
      if (uri && c && c.convertFileSrc) return c.convertFileSrc(uri);
      return uri;
    }, function () { return ''; });
  }

  /* ---- 下载：取一段二进制（原生 HTTP 给的是 base64，直接喂给 Filesystem） ---- */

  function b64clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

  function b64Bytes(b64) {
    var s = b64clean(b64), n = s.length;
    if (!n) return 0;
    var pad = 0;
    if (s.charAt(n - 1) === '=') pad++;
    if (n > 1 && s.charAt(n - 2) === '=') pad++;
    return Math.floor(n * 3 / 4) - pad;
  }

  function b64Head(b64, n) {
    var s = b64clean(b64);
    var cut = Math.max(8, Math.ceil(n / 3) * 4);
    try { return atob(s.slice(0, cut)); } catch (e) { return ''; }
  }

  function abB64(ab) {
    var b = new Uint8Array(ab), s = '', CH = 0x8000;
    for (var i = 0; i < b.length; i += CH) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function capBin(url, headers, range) {
    var cap = capHttp();
    if (!cap || !cap.get) return Promise.resolve(null);
    var h = {}, k;
    for (k in headers) if (headers[k]) h[k] = headers[k];
    if (range) h['Range'] = range;
    return cap.get({
      url: url, headers: h, responseType: 'arraybuffer',
      connectTimeout: 20000, readTimeout: 60000
    }).then(function (res) {
      if (!res) return null;
      var st = Number(res.status) || 0;
      if (res.error || (st && (st < 200 || st >= 400))) return { status: st, fail: true };
      var d = res.data;
      if (d && typeof d === 'object' && typeof d.byteLength === 'number') d = abB64(d);
      if (typeof d !== 'string' || !d) return { status: st, data: '' };
      return { status: st, data: b64clean(d), headers: res.headers || {} };
    }, function () { return null; });
  }

  /* 拆 m3u8 -> 分片绝对地址 / 子播放列表 / 是否加密 */
  function m3u8Split(text, base) {
    var lines = String(text || '').split(/\r?\n/);
    var segs = [], variants = [], enc = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      if (l.indexOf('#EXT-X-KEY') === 0) {
        var m = l.match(/METHOD=([A-Za-z0-9\-]+)/);
        if (m && m[1].toUpperCase() !== 'NONE') enc = true;
      } else if (l.indexOf('#EXT-X-STREAM-INF') === 0) {
        for (var j = i + 1; j < lines.length; j++) {
          var nx = lines[j].trim();
          if (nx && nx.charAt(0) !== '#') { variants.push(resolveUrl(base, nx)); break; }
        }
      } else if (l.charAt(0) !== '#') {
        segs.push(resolveUrl(base, l));
      }
    }
    return { segs: segs, variants: variants, enc: enc };
  }

  /* ---- 三种下法：整文件（Range 续传）/ m3u8（分片顺序拼）/ 主播放列表 ---- */

  function dlPullMore(it, headers, w, total) {
    var end = Math.min(w + DL_CHUNK - 1, total - 1);
    return capBin(it.url, headers, 'bytes=' + w + '-' + end).then(function (res) {
      if (!res || res.fail || !res.data) {
        if (!w) throw new Error('下载失败，可能是该源限制');
        return w;                                  // 下过一部分就留着，可以点「继续」
      }
      if (res.status === 200) {
        // 源不再支持断点：整段重来，免得拼出坏文件
        return fsWrite(it.file, res.data, false).then(function () {
          var n = b64Bytes(res.data);
          dlSet(it.id, { size: n });
          if (n >= total || !n) return n;
          return dlPullMore(it, headers, n, total);
        });
      }
      var sz = b64Bytes(res.data);
      return fsWrite(it.file, res.data, true).then(function () {
        w += sz;
        dlSet(it.id, { size: w });
        if (w >= total || !sz) return w;
        return dlPullMore(it, headers, w, total);
      });
    });
  }

  function dlPullFile(it, headers, head, total, status) {
    if (status === 200) {
      // 源不支持 Range：这一块就是整个文件
      return fsWrite(it.file, head, false).then(function () {
        var n = b64Bytes(head);
        dlSet(it.id, { size: n });
        return n;
      });
    }
    if (!total) total = b64Bytes(head);
    var w0 = Number(it.size) || 0;
    if (w0 >= total) return Promise.resolve(w0);
    if (w0 > 0) return dlPullMore(it, headers, w0, total);
    return fsWrite(it.file, head, false).then(function () {
      var w = b64Bytes(head);
      dlSet(it.id, { size: w });
      if (w >= total) return w;
      return dlPullMore(it, headers, w, total);
    });
  }

  function b64Bin(s) {
    var bin;
    try { bin = atob(b64clean(s)); } catch (e) { return null; }
    var n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 分片攒够 4MB 再落一次盘：一集几百个分片，逐个写会明显变慢 */
  function dlFlush(it, flushed, pend, bytes) {
    if (!pend.length) return Promise.resolve(flushed);
    var all = new Uint8Array(bytes), off = 0, i;
    for (i = 0; i < pend.length; i++) { all.set(pend[i], off); off += pend[i].length; }
    pend.length = 0;
    return fsWrite(it.file, abB64(all.buffer), flushed).then(function () { return true; });
  }

  function dlSegLoop(it, headers, segs, i, got, flushed, pend, pendN) {
    if (i >= segs.length) return dlFlush(it, flushed, pend, pendN).then(function () { return got; });
    return capBin(segs[i], headers, null).then(function (r) {
      if (!r || r.fail || !r.data) {
        dlSet(it.id, { done: i, total: segs.length, size: got });
        return dlSegLoop(it, headers, segs, i + 1, got, flushed, pend, pendN);  // 单片失败也继续往下
      }
      var u8 = b64Bin(r.data);
      if (u8 && u8.length) { pend.push(u8); pendN += u8.length; got += u8.length; }
      dlSet(it.id, { done: i + 1, total: segs.length, size: got });
      if (pendN < 4 * 1024 * 1024) {
        return dlSegLoop(it, headers, segs, i + 1, got, flushed, pend, pendN);
      }
      return dlFlush(it, flushed, pend, pendN).then(function (f) {
        return dlSegLoop(it, headers, segs, i + 1, got, f, [], 0);
      });
    });
  }

  function dlPullM3u8(it, headers, text) {
    var base = String(it.url).split('?')[0];
    var p = m3u8Split(text, base);
    if (p.variants.length && !p.segs.length) {
      return httpGet(p.variants[0], headers, 25000).then(function (t2) {
        var p2 = m3u8Split(t2 || '', p.variants[0].split('?')[0]);
        if (p2.enc || p.enc) throw new Error('该线路是加密视频，缓存下来也播不了');
        if (!p2.segs.length) throw new Error('没有解析到视频分片');
        return dlSegLoop(it, headers, p2.segs, 0, 0, false, [], 0);
      });
    }
    if (p.enc) throw new Error('该线路是加密视频，缓存下来也播不了');
    if (!p.segs.length) throw new Error('没有解析到视频分片');
    // 续传：上次下到第几片就从第几片接着写
    var d0 = Number(it.done) || 0;
    if (d0 > p.segs.length) d0 = 0;
    var s0 = d0 ? (Number(it.size) || 0) : 0;
    return dlSegLoop(it, headers, p.segs, d0, s0, d0 > 0, [], 0);
  }

  function dlWork(it) {
    var headers = { 'Referer': it.ref || it.url };
    dlSet(it.id, { state: '下载中', error: '' });
    return fsStat(it.file).then(function (st) {
      if (!st) dlSet(it.id, { done: 0, size: 0 });
      it = dlFind(it.id) || it;
      return capBin(it.url, headers, 'bytes=0-' + (DL_CHUNK - 1)).then(function (r) {
        if (!r || r.fail || !r.data) throw new Error('连不上资源地址');
        var head = b64Head(r.data, 512);
        if (head.indexOf('#EXTM3U') >= 0) {
          // 播放列表：取完整文本再拆（首块可能被 Range 截断）
          return httpGet(it.url, headers, 25000).then(function (text) {
            return dlPullM3u8(it, headers, text || head, null);
          });
        }
        var total = 0;
        var cr = (r.headers && (r.headers['Content-Range'] || r.headers['content-range'])) || '';
        var m = String(cr).match(/\/(\d+)\s*$/);
        if (m) total = parseInt(m[1], 10) || 0;
        return dlPullFile(it, headers, r.data, total, Number(r.status) || 0);
      });
    }).then(function (size) {
      if (!size) throw new Error('缓存失败，可能是该源限制');
      dlSet(it.id, { state: '已完成', size: size, error: '' });
    }, function (e) {
      dlSet(it.id, { state: '已中断', error: String((e && e.message) || e || '缓存中断').slice(0, 60) });
    });
  }

  function dlPump() {
    while (dlRun < DL_CONC && dlQueue.length) {
      (function (id) {
        var it = dlFind(id);
        if (!it || it.state === '已完成') { delete dlActive[id]; return; }
        dlRun++;
        dlWork(it).then(function () {
          delete dlActive[id];
          dlRun--;
          setTimeout(dlPump, 0);
        });
      })(dlQueue.shift());
    }
  }

  function dlEnqueue(id) {
    dlSet(id, { state: '排队中', error: '' });
    if (dlActive[id]) return;
    dlActive[id] = 1;
    dlQueue.push(id);
    setTimeout(dlPump, 0);
  }

  function dlAdd(group, drama, epName, url, ref, order) {
    var id = md5hex(url + '|' + epName + '|' + Date.now()).slice(0, 12);
    var ext = /\.mp4(\?|$)/i.test(url) ? '.mp4' : '.ts';
    var item = {
      id: id, name: epName, ep: epName, drama: drama, group: group,
      url: url, ref: ref || url,
      file: DL_DIRNAME + '/' + dlSafe(drama) + '_' + group + '/' + dlSafe(epName) + '_' + id + ext,
      state: '排队中', done: 0, total: 0, size: 0, error: '',
      created: Date.now() / 1000 + (order || 0) * 0.001
    };
    var a = dlTable();
    a.push(item);
    dlSaveTable(a);
    dlEnqueue(id);
    return item;
  }

  /* ---- 对外的五个接口 ---- */

  function dlStartLocal(body) {
    var url = cleanUrl(body.url || '');
    if (!url || !/^https?:/i.test(url)) return Promise.resolve({ ok: false, error: '下载地址无效' });
    var epName = String(body.epName || body.name || '未命名');
    var drama = String(body.groupName || body.name || '未命名');
    var gid = dlGroupId(drama, body.groupKey || '');
    var it = dlAdd(gid, drama, epName, url, body.ref || url, 0);
    return Promise.resolve({ ok: true, id: it.id, group: gid, item: it });
  }

  function dlBatchLocal(body) {
    var eps = (body.eps instanceof Array ? body.eps : []).slice(0, 100);
    if (!eps.length) return Promise.resolve({ ok: false, error: '没有要缓存的分集' });
    var drama = String(body.name || '未命名');
    var gid = dlGroupId(drama, body.key || body.site || '');
    var ref = String(body.ref || '');
    var doneNames = {};
    dlTable().forEach(function (it) {
      if (it.group === gid && it.state === '已完成') doneNames[it.ep || it.name] = 1;
    });
    // 逐集解析真实播放地址：并发 4
    return pool(eps, 4, function (e) {
      var nm = String(e.name || '未命名');
      if (doneNames[nm]) return Promise.resolve(['skip', nm]);
      return playPayload({ url: cleanUrl(e.url || '') }).then(function (r) {
        if (!r || !r.ok || !r.url) return ['skip', nm];
        return ['ok', { name: nm, url: r.url }];
      }, function () { return ['skip', nm]; });
    }).then(function (res) {
      var ready = [], skipped = [];
      (res || []).forEach(function (r) {
        if (!r) return;
        if (r[0] === 'ok') ready.push(r[1]); else skipped.push(r[1]);
      });
      if (!ready.length) {
        return { ok: false, error: '这些分集都没解析出播放地址（线路可能已失效）' };
      }
      var ids = ready.map(function (x, i) {
        return dlAdd(gid, drama, x.name, x.url, ref, i).id;
      });
      return { ok: true, group: gid, ids: ids, skipped: skipped };
    });
  }

  function dlRemoveLocal(body) {
    var id = String(body.id || ''), group = String(body.group || '');
    var a = dlTable(), keep = [], targets = [];
    a.forEach(function (it) {
      if (group ? (it.group === group) : (it.id === id)) targets.push(it);
      else keep.push(it);
    });
    if (!targets.length) return Promise.resolve({ ok: false, error: '任务不存在' });
    dlSaveTable(keep);
    targets.forEach(function (it) {
      delete dlActive[it.id];
      dlQueue = dlQueue.filter(function (x) { return x !== it.id; });
      fsDelete(it.file);
    });
    return Promise.resolve({ ok: true });
  }

  function dlResumeLocal(body) {
    var it = dlFind(String(body.id || ''));
    if (!it) return Promise.resolve({ ok: false, error: '任务不存在' });
    if (it.state === '下载中' || it.state === '排队中') return Promise.resolve({ ok: true, item: it });
    dlEnqueue(it.id);
    return Promise.resolve({ ok: true, item: dlFind(it.id) });
  }

  function dlListLocal() {
    var a = dlNormalize();
    a.sort(function (x, y) { return (y.created || 0) - (x.created || 0); });
    var pos = {}, n = 0, tot = {}, done = {};
    a.forEach(function (it) {
      if (it.state === '排队中') { n++; pos[it.id] = n; }
      var g = it.group || '';
      if (!g) return;
      tot[g] = (tot[g] || 0) + 1;
      if (it.state === '已完成') done[g] = (done[g] || 0) + 1;
    });
    var jobs = a.map(function (it) {
      var base = {};
      for (var k in it) base[k] = it[k];
      base.queuePos = pos[it.id] || 0;
      base.groupDone = done[it.group || ''] || 0;
      base.groupTotal = tot[it.group || ''] || 0;
      if (it.state === '排队中') return Promise.resolve(base);
      return fsPlayUrl(it.file).then(function (u) {
        return fsStat(it.file).then(function (st) {
          base.path = u || '';
          base.exists = !!st;
          if (st && st.size) base.size = st.size;
          return base;
        });
      });
    });
    return Promise.all(jobs).then(function (list) { return { ok: true, list: list }; });
  }

  /* ------------------------------------------------ 接口分发（1:1 对齐 server.py） */

  function handle(path, params, post) {
    params = params || {};
    var p = Promise.resolve(null);

    try {
      switch (path) {
      /* ---- 源管理 ---- */
      case '/state': p = Promise.resolve(statePayload()); break;
      case '/source/add': p = sourceAdd(post || {}); break;
      case '/source/remove': p = sourceRemove(post || {}); break;
      case '/source/toggle': p = sourceToggle(post || {}); break;
      case '/source/refresh': p = sourceRefresh(post || {}); break;
      case '/source/move': p = sourceMove(post || {}); break;
      case '/source/test': p = sourceTest(post || {}); break;

      /* ---- 站点 / 分类 / 列表 ---- */
      case '/sites': p = Promise.resolve(sitesPayload()); break;
      case '/categories': p = categoriesPayload(params.site); break;
      case '/list': p = listPayload(params); break;
      case '/feedcats': p = feedCatsPayload(); break;
      case '/feed': p = feedPayload(params); break;
      case '/detail': p = detailPayload(params); break;
      case '/search': p = searchPayload(params); break;
      case '/searchsite': p = searchSitePayload(params); break;
      case '/hot': p = hotPayload(params); break;

      /* ---- 播放：手机端没有服务端解析 ---- */
      case '/play': p = playPayload(params); break;
      case '/custom': p = customPayload(params); break;
      case '/live': p = livePayload(params); break;

      /* ---- 收藏 / 历史 / 进度：本机 localStorage ---- */
      case '/favorite': p = Promise.resolve(favoriteHandler(post)); break;
      case '/history': p = Promise.resolve(historyHandler(post, params)); break;
      case '/progress': p = Promise.resolve(progressHandler(post, params)); break;

      /* ---- 手机端没有预索引 ---- */
      case '/index/status':
      case '/index/refresh':
        p = Promise.resolve({
          ok: true,
          index: { running: false, done: false, started: 0, total: 0, sites: {} }
        });
        break;

      /* ---- 离线缓存：直接存到 App 私有目录 ---- */
      case '/dl/list': p = dlListLocal(); break;
      case '/dl/start': p = dlStartLocal(post || {}); break;
      case '/dl/batch': p = dlBatchLocal(post || {}); break;
      case '/dl/remove': p = dlRemoveLocal(post || {}); break;
      case '/dl/resume': p = dlResumeLocal(post || {}); break;

      /* ---- 需要电脑端的能力 ---- */
      case '/health':
      case '/lanip':
      case '/cast/scan':
      case '/cast/play':
      case '/shutdown':
        p = Promise.resolve({ ok: false, error: PLACEHOLDER.error });
        break;

      default:
        p = Promise.resolve({ ok: false, error: '未知接口 ' + path });
      }
    } catch (e) {
      return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
    }

    return p.catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
  }

  return {
    handle: handle,
    installNativeXhr: installNativeXhr,
    /* 供调试 / 排查用 */
    _httpGet: httpGet,
    _md5: md5hex,
    _srcId: srcId
  };
})();
