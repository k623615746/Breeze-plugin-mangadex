# MangaDex 漫画源 · Breeze 插件

给 [Breeze](https://github.com/deretame/Breeze) 漫画阅读器写的 MangaDex 源，走**官方公开 REST API**，不解析 HTML。

- 仓库：<https://github.com/k623615746/Breeze-plugin-mangadex>
- 版本：1.0.1
- 站点：<https://mangadex.org>

---

## 安装

**方式一：插件商店（推荐）**

仓库名符合 Breeze 收录规范（`Breeze-plugin-` 前缀 + 公开 + 根目录有 `manifest.json`），
客户端扫描 GitHub 后自动收录，通常 2~4 小时入库。之后在 **发现页 → 插件 → 商店** 搜「MangaDex」。

**方式二：本地安装**

下载 [Releases](https://github.com/k623615746/Breeze-plugin-mangadex/releases/latest) 里的
`breeze-plugin-mangadex.bundle.cjs`，在 **发现页 → 插件 → 设置 → 插件管理 → 更新 → 从本地安装**。

**方式三：网络安装**

同一对话框选「从网络安装」，填入：

```
https://github.com/k623615746/Breeze-plugin-mangadex/releases/download/1.0.1/breeze-plugin-mangadex.bundle.cjs
```

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 发现页入口 | 最多关注 / 最新上架 / 最近更新 / 评分最高 |
| 搜索 | 关键词搜索，服务端分页 |
| 筛选 | 排序、章节语言、连载状态、原作语言 |
| 详情 | 标题、作者、画师、标签、状态、年份、简介 |
| 章节 | 按语言筛选，自动去重同一话的多个汉化组版本 |
| 阅读 | at-home 服务直连，无需登录 |
| 设置 | 16 种阅读语言、数据节省模式、成人内容开关 |

### 接口映射

| 能力 | 端点 |
| --- | --- |
| 搜索 / 排行 | `GET /manga?title=&order[...]=&offset=` |
| 详情 | `GET /manga/{id}?includes[]=cover_art&includes[]=author` |
| 章节 | `GET /manga/{id}/feed?translatedLanguage[]=&order[chapter]=asc` |
| 图片 | `GET /at-home/server/{chapterId}` → `{baseUrl}/data/{hash}/{file}` |
| 封面 | `https://uploads.mangadex.org/covers/{id}/{file}.512.jpg` |

---

## 实现要点

**限速与 UA。** MangaDex 要求每个请求带可识别的 User-Agent，全局限速约 5 req/s。
代码里做了 220ms 的请求间隔串行化，429 会转成可读错误。

**外链章节要过滤。** MangaDex 上有两类章节：自托管（有页图）和外链到官方平台（无页图）。
插件只把前者放进章节列表；若某作品全是外链，会在简介里明确说明「本站不托管图片」，
而不是给一个点不开的列表。

**语言资源不均。** 实测英语 54,609 部、繁中 1,032、简中 764、日语 200。
日漫中文版多为官方外链，MangaDex 自己不托管——这一点在插件描述里也写明了，
避免用户以为「搜不到中文就是插件坏了」。

---

## 开发

```bash
npm install

npx tsc --noEmit                  # 类型检查
npx tsx build/generate-manifest.ts
npx rspack build
npx tsx build/generate-brotli.ts

npx tsx test/e2e.test.ts          # 8 项，真实请求官方 API
```

测试是真联网的，包含图片下载与文件头（JPEG/PNG 魔数）校验，不是 mock。
最新结果：**8/8 通过**。

源码结构：

```
src/
  common.ts   # 常量、多语言文本挑选、封面 URL、列表条目转换
  api.ts      # API 封装：节流、UA、查询串构造、章节/图片接口
  get-info.ts # 插件注册信息 + manifest 生成
  index.ts    # 13 个 fnPath 实现
```

### 更新机制

`getInfo` 与 `manifest.json` 均配置了 `updateUrl` 指向本仓库的 Release API，
客户端启动后会静默比对版本。

发新版：改 `src/get-info.ts` 的 `version` → 重新构建 → 建一个 **tag 与 version 完全一致**
（如 `1.0.0`，不加 `v` 前缀）的 Release，上传 `dist/` 两个产物和 `manifest.json`。

---

## 声明

本插件仅调用 MangaDex 公开 API 做数据转换，不存储、不缓存、不分发任何漫画内容，
所有图片均从官方 at-home 服务实时获取。

内容为社区上传的粉丝翻译，版权归原作者及出版方所有。请遵守
[MangaDex API 条款](https://api.mangadex.org/docs/)（限速、不热链图片），并支持正版。
