/* ============================================================
   独享库 · 公网版接口代理（Vercel 版）
   ------------------------------------------------------------
   为什么需要它：
     采集源的接口（api.php/provide/vod/）一个跨域头都不发。网页一旦放到
     公网上，浏览器就会拒绝直接读这些接口 —— 片单、分类、搜索、详情全加载不出来。
     这个函数只做一件事：替浏览器去取，再带跨域头返回。
     视频流（m3u8 / ts）自带跨域头，不用走这里。

   放在哪：
     本文件固定在项目里的 api/proxy.js 这个位置，不用改。
     Vercel 看到 api 目录就会自动把它发布成一个接口，不需要任何配置。
   ============================================================ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/* ---------- 防滥用：只代取「采集接口」和「图片」两类地址 ----------
   不加这道限制的话，这个接口就成了谁都能用的公开代理，可能被人拿去刷额度。
   内置的 16 个源都是苹果CMS格式（路径里带 /api.php），第一条规则就全覆盖了；
   视频流（m3u8 / ts）自带跨域头，根本不经过这里，所以下面没有 .ts / .mp4。
   以后若自己加了非常规格式的源、或海报加载不出来，把它的域名填进 EXTRA_HOSTS。 */
const EXTRA_HOSTS = [];  // 例：['my-api.example.com', 'img.example.com']

const BUILTIN_HOSTS = [
  'jisuziyuan.com', 'jszyapi.com', 'cj.lziapi.com', 'cj.ffzyapi.com',
  'bfzyapi.com', 'api.apibdzy.com', 'jinyingzy.com', 'suoniapi.com',
  'www.mdzyapi.com', 'tyyszy.com', 'www.huyaapi.com', 'api.zuidapi.com',
  'caiji.dyttzyapi.com', 'wujinapi.com', 'www.hongniuzy2.com', 'www.360zy.com'
];

const OK_EXT = /\.(jpe?g|png|gif|webp|bmp|ico|svg|json|m3u8|m3u|txt)([?#]|$)/i;

function allowed(u) {
  if (EXTRA_HOSTS.indexOf(u.hostname) >= 0) return true;
  if (BUILTIN_HOSTS.indexOf(u.hostname) >= 0) return true;
  const p = u.pathname + u.search;
  if (p.indexOf('/api.php') >= 0) return true;    // 苹果CMS 采集接口
  if (p.indexOf('?ac=') >= 0) return true;         // 部分源的另一种写法
  if (OK_EXT.test(p)) return true;                 // 海报等图片 / live 列表
  return false;
}

function send(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '只支持 GET');

  // 自己从 req.url 里取参数（不依赖任何框架的写法，Vercel 怎么进来都能取到）
  const target = new URL(req.url || '/', 'http://x').searchParams.get('url');
  if (!target) return send(res, 400, '缺少 url 参数');

  let u;
  try { u = new URL(target); } catch (e) { return send(res, 400, '地址不合法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return send(res, 403, '只支持 http / https');
  if (!allowed(u)) return send(res, 403, '这个地址不在允许范围内（代理只转发采集接口和图片）');

  // 25 秒拿不到就放弃，避免函数被上游拖着空转（Vercel 免费额度按时长算）
  const ac = new AbortController();
  const timer = setTimeout(function () { ac.abort(); }, 25000);
  let up;
  try {
    up = await fetch(u.toString(), {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': UA,
        // 采集源的图片大多有防盗链，用地址本身当 Referer
        // （与电脑版 server.py 的 /img 代理保持一致的做法）
        'Referer': u.toString(),
        'Accept': '*/*'
      }
    });
  } catch (e) {
    clearTimeout(timer);
    return send(res, 502, '上游取不到：' + (e && e.message ? e.message : e));
  }
  clearTimeout(timer);

  const buf = Buffer.from(await up.arrayBuffer());
  res.statusCode = up.status;
  const ct = up.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'public, max-age=600');
  if (req.method === 'HEAD') return res.end();
  res.end(buf);
};
