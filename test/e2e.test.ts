/**
 * MangaDex 插件端到端测试（真实请求官方 API）
 * 运行：npx tsx test/e2e.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugin = require("../dist/breeze-plugin-mangadex.bundle.cjs").default;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

const UA = "BreezePlugin-MangaDex-E2E/1.0";

/** 动态找一个真正有自托管页图的作品（很多热门作品章节全是官方外链） */
async function findHostedSample(): Promise<{ mangaId: string; chapterId: string; title: string }> {
  const res = await fetch(
    "https://api.mangadex.org/chapter?limit=30&order%5BreadableAt%5D=desc&contentRating%5B%5D=safe&contentRating%5B%5D=suggestive",
    { headers: { "User-Agent": UA } },
  );
  const json = (await res.json()) as { data: Array<Record<string, any>> };
  for (const chapter of json.data) {
    if (chapter.attributes?.pages > 0 && !chapter.attributes?.externalUrl) {
      const mangaRel = (chapter.relationships ?? []).find((r: any) => r.type === "manga");
      if (mangaRel?.id) {
        return { mangaId: mangaRel.id, chapterId: chapter.id, title: "" };
      }
    }
  }
  throw new Error("找不到带自托管章节的作品");
}

const sample = await findHostedSample();
console.log(`\n[MangaDex E2E] 样本作品 ${sample.mangaId}`);

await check("getInfo 注册信息", async () => {
  const info = await plugin.getInfo();
  assert.equal(info.name, "MangaDex");
  assert.equal(info.version, "1.0.0");
  assert.ok(info.function.length >= 3, `入口数=${info.function.length}`);
});

await check("排行榜拉取列表", async () => {
  const res = await plugin.getRankingData({ page: 1, extern: { order: "followedCount", dir: "desc" } });
  assert.ok(res.data.items.length > 0, "列表为空");
  const first = res.data.items[0];
  assert.ok(first.id && first.title, `id=${first.id} title=${first.title}`);
  assert.ok(first.cover.url.includes("uploads.mangadex.org"), first.cover.url);
});

await check("搜索命中关键词", async () => {
  const res = await plugin.searchComic({ keyword: "solo leveling", page: 1 });
  assert.ok(res.items.length > 0, "搜索无结果");
  const titles = res.items.map((i: { title: string }) => i.title.toLowerCase());
  assert.ok(titles.some((t: string) => t.includes("solo") || t.includes("leveling")), titles.slice(0, 3).join(" | "));
});

await check("空关键词返回空", async () => {
  const res = await plugin.searchComic({ keyword: "", page: 1 });
  assert.equal(res.items.length, 0);
  assert.equal(res.paging.hasReachedMax, true);
});

await check("筛选器字段完整", async () => {
  const res = await plugin.getRankingFilterBundle();
  const keys = res.scheme.fields.map((f: { key: string }) => f.key);
  assert.deepEqual(keys, ["sort", "language", "status", "originalLanguage"]);
});

await check("详情 + 章节列表", async () => {
  const res = await plugin.getComicDetail({ comicId: sample.mangaId });
  const normal = res.data.normal;
  assert.ok(normal.comicInfo.title.length > 0, "标题为空");
  assert.ok(normal.comicInfo.cover.url.includes("uploads.mangadex.org"));
  assert.ok(normal.eps.length > 0, `章节数=${normal.eps.length}`);
  console.log(`    作品：${normal.comicInfo.title}，章节 ${normal.eps.length} 话`);
});

await check("阅读页图片链路", async () => {
  const detail = await plugin.getComicDetail({ comicId: sample.mangaId });
  const chapterId = detail.data.normal.eps[0].requestId;
  const res = await plugin.getReadSnapshot({ comicId: sample.mangaId, chapterId });
  const pages = res.data.chapter.pages;
  assert.ok(pages.length > 0, "无图片页");
  assert.ok(pages[0].url.startsWith("https://"), pages[0].url);

  const bytes = await plugin.fetchImageBytes({ url: pages[0].url });
  assert.ok(bytes instanceof Uint8Array, typeof bytes);
  assert.ok(bytes.length > 5000, `字节数=${bytes.length}`);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  assert.ok(isJpeg || isPng, `魔数=${bytes[0].toString(16)},${bytes[1].toString(16)}`);
  console.log(`    ${pages.length} 页，首图 ${bytes.length} B`);
});

await check("设置页可读", async () => {
  const res = await plugin.getSettingsBundle();
  const keys = res.data.values;
  assert.ok(keys && typeof keys === "object");
  assert.equal(res.data.canLogin, false);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
