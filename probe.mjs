import 'dotenv/config';
import { callUserDataApi, parseNextOffset } from '../src/lib/zhihu.js';

const secret = process.env.ZHIHU_ACCESS_SECRET;
console.log('secret configured:', Boolean(secret));

async function probe(name, path, query) {
  try {
    const d = await callUserDataApi(path, query, { accessSecret: secret });
    const n = (d.Items || []).length;
    console.log(`[OK] ${name}: items=${n}` + (d.Paging ? ` paging=${JSON.stringify(d.Paging)}` : ' (no paging)'));
    if (d.Paging) console.log(`     parseNextOffset => ${parseNextOffset(d.Paging)}`);
    if (d.Items?.[0]) console.log(`     sample: ${(d.Items[0].Title || '').slice(0, 40)}`);
  } catch (e) {
    console.log(`[ERR] ${name}: code=${e.code} ${e.message}`);
  }
}

await probe('favlists', '/api/v1/user/favlists', { Limit: 50 });
await probe('collections', '/api/v1/user/collections', { Limit: 20 });
await probe('contents', '/api/v1/user/contents', { ContentType: 'all', Limit: 2 });
await probe('followees', '/api/v1/user/followees', { Limit: 3 });
