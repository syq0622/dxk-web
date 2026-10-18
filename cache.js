/* ============================================================
   独享库 · 本地缓存层
   ------------------------------------------------------------
   目的：让「打开就有内容」。
     · 片单 / 分类树 / 线路表 存 IndexedDB（localStorage 只有 5MB，装不下）；
     · 海报图存 Cache Storage，限量淘汰；
     · 进首页先渲染缓存（秒开），再后台联网刷新 —— stale-while-revalidate。

   原则：尽力而为。
     拿不到、被系统清理、浏览器不支持，都必须能正常走网络，
     缓存出问题绝不能让页面报错或白屏。所有方法都不会 reject 到调用方。
   ============================================================ */
window.DXKCache = (function () {
  'use strict';

  var DB_NAME = 'dxk';
  var DB_VER = 1;

  var FEED_TTL = 10 * 60 * 1000;          // 片单软过期：过了就先显示旧的、同时刷新
  var FEED_MAX_KEYS = 300;                // 片单最多留多少个键
  var FEED_MAX_BYTES = 8 * 1024 * 1024;   // 片单数据总量上限
  var CANDS_MAX = 500;                    // 线路表最多留多少条片
  var CATS_TTL = 24 * 60 * 60 * 1000;     // 分类树 24 小时

  var IMG_CACHE = 'dxk-img-v1';
  var IMG_MAX = 300;                      // 海报最多留多少张
  var IMG_SKIP_BYTES = 200 * 1024;        // 单张超过 200KB 不缓存

  var _db = null;
  var _dbPromise = null;

  /* ---------------- IndexedDB 底层 ---------------- */

  function openDB() {
    if (_db) return Promise.resolve(_db);
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve) {
      try {
        if (!window.indexedDB) { resolve(null); return; }
        var req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('feed')) db.createObjectStore('feed');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          if (!db.objectStoreNames.contains('cands')) db.createObjectStore('cands');
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return _dbPromise;
  }

  function tx(store, mode, fn) {
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var t = db.transaction(store, mode || 'readonly');
          var s = t.objectStore(store);
          var out;
          var r = fn(s);
          if (r && typeof r.then === 'function') {
            r.then(function (v) { out = v; });
          } else if (r && 'onsuccess' in r) {
            r.onsuccess = function () { out = r.result; };
          } else {
            out = r;
          }
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { resolve(null); };
          t.onabort = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function get(store, key) { return tx(store, 'readonly', function (s) { return s.get(key); }); }
  function put(store, key, val) { return tx(store, 'readwrite', function (s) { s.put(val, key); return true; }); }
  function del(store, key) { return tx(store, 'readwrite', function (s) { s.delete(key); return true; }); }
  function allKeys(store) { return tx(store, 'readonly', function (s) { return s.getAllKeys(); }); }

  function bytesOf(v) {
    try { return JSON.stringify(v).length; } catch (e) { return 0; }
  }

  /* LRU：meta 里存 {key: 时间戳}，超量时删最旧的 */
  function lruTouch(metaKey, key, max, extraDel) {
    return get('meta', metaKey).then(function (m) {
      m = m || {};
      m[key] = Date.now();
      var keys = Object.keys(m);
      if (keys.length <= max) return put('meta', metaKey, m);
      keys.sort(function (a, b) { return m[a] - m[b]; });
      var drop = keys.slice(0, keys.length - max);
      drop.forEach(function (k) {
        delete m[k];
        if (extraDel) extraDel(k);
      });
      return put('meta', metaKey, m);
    });
  }

  /* LRU 淘汰时顺带删掉真实数据（海报用） */
  function imgDrop(url) {
    if (!window.caches) return;
    caches.open(IMG_CACHE).then(function (c) { return c.delete(url); }).catch(function () {});
  }

  /* 存一张海报进 Cache Storage，并驱动 LRU / 张数上限 */
  function imgStore(url, response) {
    return caches.open(IMG_CACHE).then(function (c) {
      return c.put(url, response);
    }).then(function () {
      return lruTouch('imgLRU', url, IMG_MAX, imgDrop);
    }).then(function () { return true; }).catch(function () { return false; });
  }

  /* ---------------- 片单 ---------------- */

  function feedKey(params) {
    params = params || {};
    var cat = params.cat || 'latest';
    var sub = params.sub || '';
    var page = params.page || 1;
    return 'feed:' + cat + '|' + sub + '|' + page;
  }

  return {
    feedKey: feedKey,

    /** 取片单缓存；返回 {data, age} 或 null。age 是毫秒 */
    feedGet: function (params) {
      var k = feedKey(params);
      return get('feed', k).then(function (rec) {
        if (!rec || !rec.data) return null;
        return { data: rec.data, age: Date.now() - (rec.t || 0) };
      }).catch(function () { return null; });
    },

    feedFresh: FEED_TTL,

    /** 写片单缓存（顺带做 LRU 与容量控制） */
    feedPut: function (params, data) {
      if (!data || !data.ok) return Promise.resolve(false);
      var k = feedKey(params);
      var rec = { t: Date.now(), bytes: bytesOf(data), data: data };
      return put('feed', k, rec).then(function () {
        return lruTouch('feedLRU', k, FEED_MAX_KEYS, function (old) { del('feed', old); });
      }).then(function () {
        return get('meta', 'feedBytes');
      }).then(function (m) {
        m = m || {};
        m[k] = rec.bytes;
        var keys = Object.keys(m), tot = 0, i;
        for (i = 0; i < keys.length; i++) tot += m[keys[i]] || 0;
        if (tot <= FEED_MAX_BYTES) return put('meta', 'feedBytes', m);
        // 超量：按 LRU 顺序删到不超
        return get('meta', 'feedLRU').then(function (lru) {
          lru = lru || {};
          var ks = Object.keys(m).sort(function (a, b) { return (lru[a] || 0) - (lru[b] || 0); });
          for (var j = 0; j < ks.length && tot > FEED_MAX_BYTES; j++) {
            tot -= m[ks[j]] || 0;
            delete m[ks[j]];
            del('feed', ks[j]);
          }
          return put('meta', 'feedBytes', m);
        });
      }).catch(function () { return false; });
    },

    /** 分类树 */
    feedCatsGet: function () {
      return get('meta', 'feedcats').then(function (rec) {
        if (!rec || !rec.data) return null;
        var age = Date.now() - (rec.t || 0);
        return { data: rec.data, age: age, fresh: age < CATS_TTL };
      }).catch(function () { return null; });
    },
    feedCatsPut: function (data) {
      if (!data || !data.ok) return Promise.resolve(false);
      return put('meta', 'feedcats', { t: Date.now(), data: data }).catch(function () { return false; });
    },

    /** 线路表：片名归一 → 各源线路 */
    candsGet: function (name) {
      return get('cands', name).then(function (v) { return v || null; }).catch(function () { return null; });
    },
    candsPut: function (name, cands) {
      if (!name || !cands || !cands.length) return Promise.resolve(false);
      return put('cands', name, cands).then(function () {
        return lruTouch('candsLRU', name, CANDS_MAX, function (old) { del('cands', old); });
      }).catch(function () { return false; });
    },

    /* ---------------- 海报图 ---------------- */

    /** 命中返回 blob: 地址，否则 null（并顺手删掉可能存在的死记录） */
    imgGet: function (url) {
      if (!url || !window.caches) return Promise.resolve(null);
      return caches.open(IMG_CACHE).then(function (c) {
        return c.match(url);
      }).then(function (res) {
        if (!res) return null;
        return res.blob();
      }).then(function (b) {
        return b ? URL.createObjectURL(b) : null;
      }).catch(function () { return null; });
    },

    /** 存图（blob）；超过单张上限或缓存不可用则跳过 */
    imgPut: function (url, blob) {
      if (!url || !blob || !window.caches) return Promise.resolve(false);
      if (blob.size > IMG_SKIP_BYTES) return Promise.resolve(false);
      return imgStore(url, new Response(blob, {
        headers: { 'Content-Type': blob.type || 'image/jpeg' }
      }));
    },

    /** 预热海报：并发 4，最多 limit 张；跨域取不到就跳过（尽力而为） */
    imgPreheat: function (urls, limit) {
      if (!window.caches || !urls || !urls.length) return Promise.resolve(0);
      limit = limit || 60;
      var list = urls.slice(0, limit), done = 0, i = 0;
      function worker() {
        if (i >= list.length) return Promise.resolve();
        var u = list[i++];
        return caches.open(IMG_CACHE).then(function (c) {
          return c.match(u).then(function (hit) {
            if (hit) return;
            return fetch(u, { mode: 'no-cors' }).then(function (r) {
              if (!r || !r.ok && r.type !== 'opaque') return;
              return imgStore(u, r).then(function () { done++; });
            });
          });
        }).catch(function () {});
      }
      function loop() {
        return worker().then(function () {
          if (i < list.length) return loop();
        });
      }
      var jobs = [];
      for (var k = 0; k < 4; k++) jobs.push(loop());
      return Promise.all(jobs).then(function () { return done; });
    },

    /** 缓存用量：片单条数 / 是否有分类树 / 海报张数（「我的」页显示用） */
    stats: function () {
      var out = { feed: 0, cats: 0, img: 0 };
      return allKeys('feed').then(function (ks) {
        out.feed = (ks || []).length;
        return get('meta', 'feedcats');
      }).then(function (c) {
        out.cats = (c && c.data) ? 1 : 0;
        return get('meta', 'imgLRU');
      }).then(function (m) {
        out.img = m ? Object.keys(m).length : 0;
        return out;
      }).catch(function () { return out; });
    },

    /** 清空全部缓存（「我的」页可调用） */
    clearAll: function () {
      var jobs = [];
      ['feed', 'meta', 'cands'].forEach(function (s) {
        jobs.push(tx(s, 'readwrite', function (os) { if (os.clear) os.clear(); return true; }));
      });
      if (window.caches && caches.delete) jobs.push(caches.delete(IMG_CACHE).catch(function () {}));
      return Promise.all(jobs).catch(function () {});
    }
  };
})();
