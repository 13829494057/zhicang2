import 'dotenv/config';
import { callUserDataApi, parseNextOffset } from '../src/lib/zhihu.js';

const secret = process.env.ZHIHU_ACCESS_SECRET;
const ctx = { accessSecret: secret };

const lists = await callUserDataApi('/api/v1/user/favlists', { Limit: 50 }, ctx);
for (const f of lists.Items || []) {
  console.log(`收藏夹: ${f.Title} | UrlToken=${f.UrlToken} (${typeof f.UrlToken}) | IsPublic=${f.IsPublic}`);
}

const first = lists.Items?.[0];
if (!first) {
  console.log('无收藏夹可测');
  process.exit(0);
}

console.log('\n--- 翻页测试 ---');
let offset = 0;
let page = 0;
let total = 0;
while (page < 3) {
  const d = await callUserDataApi(
    '/api/v1/user/favlist_contents',
    { FavlistUrlToken: first.UrlToken, Offset: offset, Limit: 5 },
    ctx
  );
  const items = d.Items || [];
  total += items.length;
  console.log(`page${page} offset=${offset} got=${items.length} paging=${JSON.stringify(d.Paging)}`);
  if (items[0]) {
    const it = items[0];
    console.log(`   title=${(it.Title||'').slice(0,30)}`);
    console.log(`   FavTime=${it.FavTime} CreatedAt=${it.CreatedAt} Author=${it.Author ? it.Author.Name : 'null(非必返)'}`);
    console.log(`   Favlists=${(it.Favlists||[]).length} 个`);
  }
  const next = parseNextOffset(d.Paging);
  if (next === null) { console.log('   -> IsEnd, 停止翻页'); break; }
  offset = next;
  page++;
}
console.log(`累计取到 ${total} 条`);
