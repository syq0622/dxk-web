/* ============================================================
   独享库 · 云同步配置（Supabase 免费版）
   ------------------------------------------------------------
   把下面两行换成你自己的即可。留空 = 不启用云同步，所有功能照旧（纯本地）。
   这两样东西是「公开密钥」，只能读写自己账号的数据，可以安全地放在客户端。
   ============================================================ */
window.DXK_CONFIG = {
  supabaseUrl: 'https://bcoklauqzkyivjfafiqq.supabase.co',  // 项目根地址（末尾不要带 /rest/v1/）
  supabaseAnonKey: 'sb_publishable_4eq0KLJfnBqqqTyvfdnOVA_UygDOFnq',  // Publishable key（等同于旧版 anon key）
  tables: { favorites: 'favorites', sources: 'sources', progress: 'progress' }
};