import type { ComicListScene, InfoContract, PluginFunctionItem } from "breeze-plugin-kit";

import { PLUGIN_ID, UPLOADS_BASE } from "./common";

/** 发布仓库：Breeze 只会扫描 GitHub 上以 Breeze-plugin- 开头的公开仓库 */
const GITHUB_OWNER = "k623615746";
const GITHUB_REPO = "Breeze-plugin-mangadex";

/** 自动更新通道：GitHub Release API */
const UPDATE_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;


const ICON_URL = "https://cdn.jsdelivr.net/gh/k623615746/Breeze-plugin-mangadex@main/assets/icon.png";

function buildScene(title: string, core: Record<string, unknown> = {}): ComicListScene {
  return {
    title,
    source: PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
      request: { fnPath: "getRankingData", core, extern: {} },
    },
    filter: { fnPath: "getRankingFilterBundle", core, extern: {} },
  };
}

function buildFunctions(): PluginFunctionItem[] {
  return [
    {
      id: "popular",
      title: "最多关注",
      action: { type: "openComicList", payload: { scene: buildScene("最多关注", { order: "followedCount", dir: "desc" }) } },
    },
    {
      id: "latest",
      title: "最新上架",
      action: { type: "openComicList", payload: { scene: buildScene("最新上架", { order: "createdAt", dir: "desc" }) } },
    },
    {
      id: "updated",
      title: "最近更新",
      action: { type: "openComicList", payload: { scene: buildScene("最近更新", { order: "latestUploadedChapter", dir: "desc" }) } },
    },
    {
      id: "rating",
      title: "评分最高",
      action: { type: "openComicList", payload: { scene: buildScene("评分最高", { order: "rating", dir: "desc" }) } },
    },
  ];
}

export function buildPluginInfo(): InfoContract {
  return {
    name: "MangaDex",
    uuid: PLUGIN_ID,
    iconUrl: ICON_URL,
    describe: [
      "MangaDex 漫画源，走官方公开 REST API。",
      "",
      "- 9.5 万+ 作品，多语言章节（英语约 5.4 万、繁中约 1000、简中约 760）",
      "- 支持关键词搜索、关注数/最新/更新/评分四种排行",
      "- 可按语言、内容分级、连载状态筛选",
      "- 章节图片走官方 at-home 服务，无需登录",
      "",
      "**注意**：MangaDex 的中文资源偏少，日漫中文版多外链到官方平台（本站不托管）；",
      "英文扫译资源最丰富。可在插件设置里切换阅读语言。",
      "",
      "> MangaDex 是非营利社区站，内容多为粉丝翻译。请遵守其 API 使用条款（限速、不热链图片）。",
    ].join("\n"),
    version: "1.0.1",
    home: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    updateUrl: UPDATE_URL,
    function: buildFunctions(),
  };
}

export function buildManifestInfo() {
  const info = buildPluginInfo();
  return {
    name: info.name,
    uuid: info.uuid,
    iconUrl: info.iconUrl,
    describe: info.describe,
    version: info.version,
    home: info.home,
    updateUrl: info.updateUrl,
    function: info.function,
  };
}
