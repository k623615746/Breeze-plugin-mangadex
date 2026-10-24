import type {
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPayload,
  ChapterSummary,
  ComicDetailContract,
  ComicDetailPayload,
  ComicPagedListContract,
  DownloadConcurrencyResult,
  FetchImageBytesPayload,
  FilterBundleContract,
  InfoContract,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  SettingsBundleContract,
} from "breeze-plugin-kit";
import { authConfig } from "breeze-plugin-kit";
import {
  LANGUAGES,
  PAGE_SIZE,
  PLUGIN_ID,
  STATUS_MAP,
  USER_AGENT,
  absoluteUrl,
  cleanText,
  coverUrl,
  createImage,
  createMetadata,
  mangaDescription,
  mangaTitle,
  pickLocalized,
  relationshipNames,
  toComicListItem,
  type MdManga,
} from "./common";
import {
  buildImageUrl,
  chapterDisplayName,
  fetchAtHome,
  fetchChapterFeed,
  fetchChapterFeedDetailed,
  listManga,
  mdGet,
  type MdChapter,
} from "./api";
import { buildPluginInfo } from "./get-info";
import {
  applyTranslateSettings,
  isDisplayTranslateEnabled,
  translateChapterNames,
  translateListTitles,
  translateTags,
  translateToChinese,
} from "./translate-display";

/** 设置里开了「显示翻译」才生效：把列表标题批量译成中文 */
async function maybeTranslateTitles<T extends { title: string }>(items: T[]): Promise<T[]> {
  if (!(await isDisplayTranslateEnabled())) {
    return items;
  }
  try {
    return await translateListTitles(items);
  } catch {
    return items;
  }
}


// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const KEY_LANGUAGE = "read.language";
const KEY_DATA_SAVER = "read.dataSaver";
const KEY_ADULT = "content.adult";

const DEFAULT_LANGUAGE = "en";

async function readSetting(key: string, fallback: string): Promise<string> {
  try {
    const value = await authConfig.load(key, fallback);
    return cleanText(value) || fallback;
  } catch {
    return fallback;
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  try {
    await authConfig.save(key, value);
  } catch {
    // 忽略持久化失败
  }
}

async function readLanguage(): Promise<string> {
  const lang = await readSetting(KEY_LANGUAGE, DEFAULT_LANGUAGE);
  return LANGUAGES.some((item) => item.value === lang) ? lang : DEFAULT_LANGUAGE;
}

async function readDataSaver(): Promise<boolean> {
  return (await readSetting(KEY_DATA_SAVER, "false")) === "true";
}

async function readAdult(): Promise<boolean> {
  return (await readSetting(KEY_ADULT, "false")) === "true";
}

async function currentRatings(): Promise<string[]> {
  return (await readAdult()) ? ["safe", "suggestive", "erotica"] : ["safe", "suggestive"];
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 章节转换
// ---------------------------------------------------------------------------

function toChapterSummaries(chapters: MdChapter[], mangaId: string): ChapterSummary[] {
  // 同一话可能有多个汉化组版本，按 chap 去重，保留首个
  const seen = new Set<string>();
  const result: ChapterSummary[] = [];

  chapters.forEach((chapter) => {
    const number = cleanText(chapter.attributes?.chapter) || chapter.id;
    if (seen.has(number)) {
      return;
    }
    seen.add(number);
    result.push({
      id: chapter.id,
      requestId: chapter.id,
      logicalKey: `${mangaId}-${chapter.id}`,
      storageChapterId: chapter.id,
      name: chapterDisplayName(chapter),
      order: result.length + 1,
      extern: {
        chapter: cleanText(chapter.attributes?.chapter),
        language: cleanText(chapter.attributes?.translatedLanguage),
        pages: chapter.attributes?.pages ?? 0,
      },
    });
  });

  return result;
}

// ---------------------------------------------------------------------------
// 接口实现
// ---------------------------------------------------------------------------

async function init(): Promise<{ source: string; data: { ok: boolean } }> {
  console.log("[mangadex] init");
  return { source: PLUGIN_ID, data: { ok: true } };
}

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
}

async function searchComic(payload: SearchComicPayload): Promise<SearchResultContract> {
  const keyword = cleanText(payload.keyword);
  const page = toNumber(payload.page, 1);

  if (!keyword) {
    const empty = { page: 1, pages: 1, total: 0, hasReachedMax: true };
    return {
      source: PLUGIN_ID,
      extern: null,
      scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "grid" },
      data: { paging: empty, items: [] },
      paging: empty,
      items: [],
    };
  }

  const language = await readLanguage();
  const res = await listManga({
    title: keyword,
    page,
    limit: PAGE_SIZE,
    ratings: await currentRatings(),
    availableLanguage: language,
  });

  const items = await maybeTranslateTitles((res.data ?? []).map(toComicListItem));
  const total = res.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const paging = { page, pages, total, hasReachedMax: page >= pages };

  return {
    source: PLUGIN_ID,
    extern: null,
    scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "grid" },
    data: { paging, items },
    paging,
    items,
  };
}

async function getRankingData(payload: SearchComicPayload): Promise<ComicPagedListContract> {
  const extern = (payload.extern ?? {}) as Record<string, unknown>;
  const record = payload as unknown as Record<string, unknown>;
  const page = toNumber(payload.page, 1);

  const order = pickString(extern.order, record.order) || "followedCount";
  const dir = pickString(extern.dir, record.dir) || "desc";
  const status = pickString(extern.status, record.status);
  const originalLanguage = pickString(extern.originalLanguage, record.originalLanguage);
  const availableLanguage = pickString(extern.availableLanguage, record.availableLanguage) || (await readLanguage());

  const res = await listManga({
    page,
    limit: PAGE_SIZE,
    order: { [order]: dir },
    status: status ? [status] : undefined,
    originalLanguage: originalLanguage || undefined,
    availableLanguage,
    ratings: await currentRatings(),
  });

  const items = await maybeTranslateTitles((res.data ?? []).map(toComicListItem));
  const total = res.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return {
    source: PLUGIN_ID,
    extern: null,
    data: {
      items,
      hasReachedMax: page >= pages,
    },
  };
}

async function getRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      title: "筛选",
      fields: [
        {
          key: "sort",
          kind: "choice",
          label: "排序",
          options: [
            { label: "最多关注", value: "followedCount_desc", result: { extern: { order: "followedCount", dir: "desc" } } },
            { label: "最新上架", value: "createdAt_desc", result: { extern: { order: "createdAt", dir: "desc" } } },
            { label: "最近更新", value: "latestUploadedChapter_desc", result: { extern: { order: "latestUploadedChapter", dir: "desc" } } },
            { label: "评分最高", value: "rating_desc", result: { extern: { order: "rating", dir: "desc" } } },
            { label: "标题 A-Z", value: "title_asc", result: { extern: { order: "title", dir: "asc" } } },
          ],
        },
        {
          key: "language",
          kind: "choice",
          label: "章节语言",
          options: [
            { label: "跟随设置", value: "", result: { extern: { availableLanguage: "" } } },
            ...LANGUAGES.map((item) => ({
              label: item.name,
              value: item.value,
              result: { extern: { availableLanguage: item.value } },
            })),
          ],
        },
        {
          key: "status",
          kind: "choice",
          label: "连载状态",
          options: [
            { label: "全部", value: "", result: { extern: { status: "" } } },
            { label: "连载中", value: "ongoing", result: { extern: { status: "ongoing" } } },
            { label: "已完结", value: "completed", result: { extern: { status: "completed" } } },
            { label: "休载", value: "hiatus", result: { extern: { status: "hiatus" } } },
          ],
        },
        {
          key: "originalLanguage",
          kind: "choice",
          label: "原作语言",
          options: [
            { label: "全部", value: "", result: { extern: { originalLanguage: "" } } },
            { label: "日语", value: "ja", result: { extern: { originalLanguage: "ja" } } },
            { label: "韩语", value: "ko", result: { extern: { originalLanguage: "ko" } } },
            { label: "中文", value: "zh", result: { extern: { originalLanguage: "zh" } } },
            { label: "英语", value: "en", result: { extern: { originalLanguage: "en" } } },
          ],
        },
      ],
    },
    data: {
      values: {
        sort: "followedCount_desc",
        language: "",
        status: "",
        originalLanguage: "",
      },
    },
  };
}

async function getComicDetail(payload: ComicDetailPayload): Promise<ComicDetailContract> {
  const comicId = cleanText(payload.comicId);
  if (!comicId) {
    throw new Error("缺少漫画 ID");
  }

  const language = await readLanguage();
  const res = await mdGet<{ data: MdManga }>(`/manga/${comicId}`, {
    "includes[]": ["cover_art", "author", "artist"],
  });
  const manga = res.data;
  if (!manga) {
    throw new Error("未找到该作品");
  }

  let chapters: ChapterSummary[] = [];
  let note = "";
  try {
    const feed = await fetchChapterFeedDetailed(comicId, language);
    chapters = toChapterSummaries(feed.readable, comicId);
    if (chapters.length === 0) {
      if (feed.externalCount > 0) {
        note = `\n\n（该作品在「${languageLabel(language)}」下的 ${feed.externalCount} 个章节均为官方平台外链，本站不托管图片，插件无法直接阅读；可尝试切换其他语言）`;
      } else {
        note = `\n\n（当前语言「${languageLabel(language)}」下没有可读章节，可在插件设置里切换阅读语言）`;
      }
    }
  } catch (error) {
    note = `\n\n（章节加载失败：${error instanceof Error ? error.message : String(error)}）`;
  }

  const title = mangaTitle(manga);
  const authors = relationshipNames(manga, "author");
  const status = STATUS_MAP[manga.attributes?.status ?? ""] ?? "";
  const year = manga.attributes?.year ? String(manga.attributes.year) : "";
  const tags = (manga.attributes?.tags ?? [])
    .map((tag) => pickLocalized(tag.attributes.name, ["zh", "en"]))
    .filter(Boolean)
    .slice(0, 8);

  // 可选：把标题/简介/章节名/标签译成中文（设置里开启后生效）
  let displayTitle = title;
  let displayDescription = `${mangaDescription(manga)}${note}`;
  let displayTags = tags;
  if (await isDisplayTranslateEnabled()) {
    try {
      const [titleZh, descZh, nameMap, tagMap] = await Promise.all([
        translateToChinese(title),
        translateToChinese(mangaDescription(manga)),
        translateChapterNames(chapters.map((chapter) => chapter.name)),
        translateTags(tags),
      ]);
      if (titleZh) {
        displayTitle = `${titleZh}（${title}）`;
      }
      if (descZh) {
        displayDescription = `${descZh}${note}`;
      }
      if (nameMap.size > 0) {
        chapters = chapters.map((chapter) => ({
          ...chapter,
          name: nameMap.get(chapter.name) ?? chapter.name,
        }));
      }
      if (tagMap.size > 0) {
        displayTags = tags.map((tag) => tagMap.get(tag) ?? tag);
      }
    } catch {
      // 翻译失败保留原文
    }
  }

  return {
    source: PLUGIN_ID,
    comicId,
    extern: null,
    scheme: { version: "1.0.0", type: "comicDetail", source: PLUGIN_ID },
    data: {
      normal: {
        comicInfo: {
          id: comicId,
          title: displayTitle,
          titleMeta: [],
          creator: {
            id: "",
            name: authors[0] ?? "",
            avatar: { id: "", url: "", name: "", path: "", extern: {} },
            onTap: null,
            extern: {},
          },
          description: displayDescription,
          cover: createImage({
            id: comicId,
            url: coverUrl(manga, 512),
            name: title,
            path: `comic/${comicId}/cover.jpg`,
            extern: {},
          }),
          metadata: [
            createMetadata("author", "作者", authors),
            createMetadata("works", "画家", relationshipNames(manga, "artist")),
            createMetadata("categories", "标签", displayTags),
            createMetadata("tags", "状态", [status, year].filter(Boolean)),
          ],
          extern: {},
        },
        preview: { enabled: false },
        eps: chapters,
        recommend: [],
        totalViews: 0,
        totalLikes: 0,
        totalComments: 0,
        isFavourite: false,
        isLiked: false,
        allowComments: false,
        allowLike: false,
        allowCollected: true,
        allowDownload: true,
        allowCommentsReason: "MangaDex 评论位于其站点论坛，插件未接入",
        allowLikeReason: "MangaDex 未提供点赞接口",
        extern: {},
      },
      raw: {
        id: comicId,
        title,
        status: manga.attributes?.status ?? "",
        contentRating: manga.attributes?.contentRating ?? "",
        originalLanguage: manga.attributes?.originalLanguage ?? "",
      },
    },
  };
}

function languageLabel(code: string): string {
  return LANGUAGES.find((item) => item.value === code)?.name ?? code;
}

/** 构建某章节的完整阅读数据 */
async function buildChapterData(comicId: string, chapterId: string) {
  const language = await readLanguage();
  const dataSaver = await readDataSaver();

  let chapters: ChapterSummary[] = [];
  let comicTitle = `作品 ${comicId}`;
  try {
    const res = await mdGet<{ data: MdManga }>(`/manga/${comicId}`, { "includes[]": ["cover_art"] });
    comicTitle = mangaTitle(res.data);
    const feed = await fetchChapterFeed(comicId, language);
    chapters = toChapterSummaries(feed, comicId);
  } catch (error) {
    console.log("[mangadex] 章节列表加载失败:", error instanceof Error ? error.message : error);
  }

  const atHome = await fetchAtHome(chapterId, dataSaver);
  const files = dataSaver ? atHome.chapter.dataSaver : atHome.chapter.data;
  if (!files || files.length === 0) {
    throw new Error("该章节没有可读图片（可能是外链章节）");
  }

  const pages = files.map((fileName, index) => {
    const pageNo = String(index + 1).padStart(3, "0");
    return {
      id: `${chapterId}-${pageNo}`,
      name: fileName,
      path: `comic/${comicId}/${chapterId}/${pageNo}.jpg`,
      url: buildImageUrl(atHome, fileName, dataSaver),
      extern: { index: index + 1 },
    };
  });

  const current = chapters.find((item) => item.requestId === chapterId);
  const chapter = current ?? {
    id: chapterId,
    requestId: chapterId,
    logicalKey: `${comicId}-${chapterId}`,
    storageChapterId: chapterId,
    name: `章节 ${chapterId.slice(0, 8)}`,
    order: 1,
    extern: {},
  };

  return { comicTitle, chapters, chapter: { ...chapter, pages }, dataSaver };
}

async function getReadSnapshot(payload: ReadSnapshotPayload): Promise<ReadSnapshotContract> {
  const comicId = cleanText(payload.comicId);
  const chapterId = String(payload.chapterId ?? "").trim();
  if (!chapterId) {
    throw new Error("缺少章节 ID");
  }
  const { comicTitle, chapters, chapter } = await buildChapterData(comicId, chapterId);

  return {
    source: PLUGIN_ID,
    extern: null,
    data: {
      comic: { id: comicId, source: PLUGIN_ID, title: comicTitle, extern: {} },
      chapter,
      chapters,
    },
  };
}

async function getChapter(payload: ChapterPayload): Promise<ChapterContentContract> {
  const comicId = cleanText(payload.comicId);
  const chapterId = String(payload.chapterId ?? "").trim();
  if (!chapterId) {
    throw new Error("缺少章节 ID");
  }
  const { comicTitle, chapters, chapter } = await buildChapterData(comicId, chapterId);

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId,
    extern: null,
    scheme: { version: "1.0.0", type: "chapterContent", source: PLUGIN_ID },
    data: {
      comic: { id: comicId, source: PLUGIN_ID, title: comicTitle, extern: {} },
      chapter,
      chapters,
    },
  };
}

async function fetchImageBytes(payload: FetchImageBytesPayload): Promise<Uint8Array> {
  const url = absoluteUrl(cleanText(payload.url));
  if (!url) {
    throw new Error("图片地址为空");
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "x-rquickjs-host-offload-binary-v1": "1",
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(payload.timeoutMs ?? 30000),
  });
  if (!res.ok) {
    throw new Error(`图片下载失败（HTTP ${res.status}）`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function getDownloadConcurrency(): Promise<DownloadConcurrencyResult> {
  return { concurrency: 3 };
}

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const language = await readLanguage();
  const dataSaver = await readDataSaver();
  const adult = await readAdult();

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        {
          id: "read",
          title: "阅读",
          fields: [
            {
              key: KEY_LANGUAGE,
              kind: "choice",
              label: "阅读语言",
              options: LANGUAGES.map((item) => ({ label: item.name, value: item.value })),
            },
            {
              key: KEY_DATA_SAVER,
              kind: "switch",
              label: "数据节省模式（低画质、加载更快）",
            },
          ],
        },
        {
          id: "content",
          title: "内容",
          fields: [
            {
              key: KEY_ADULT,
              kind: "switch",
              label: "显示成人内容（erotica 分级）",
            },
          ],
        },
        {
          id: "translate",
          title: "在线翻译（实验性）",
          fields: [
            {
              key: "translate.display",
              kind: "switch",
              label: "把标题/简介/章节名翻译成中文（免费翻译接口，速度较慢且有配额）",
            },
            {
              key: "translate.email",
              kind: "text",
              label: "MyMemory 邮箱（可选，注册用户配额更高）",
            },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: false,
      canLogin: false,
      values: {
        [KEY_LANGUAGE]: language,
        [KEY_DATA_SAVER]: dataSaver ? "true" : "false",
        [KEY_ADULT]: adult ? "true" : "false",
        "translate.display": (await isDisplayTranslateEnabled()) ? "true" : "false",
        "translate.email": "",
      },
    },
  };
}

async function onSettingChanged(payload?: Record<string, unknown>) {
  const key = pickString(payload?.key);
  const raw = payload?.value;
  const value = typeof raw === "boolean" ? (raw ? "true" : "false") : pickString(raw);
  if (key) {
    await writeSetting(key, value);
    // 同步翻译模块的内存态，避免再读一次配置
    applyTranslateSettings({ [key]: value });
  }
  return { source: PLUGIN_ID, data: { ok: true } };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "capabilities",
      actions: [],
    },
    data: {},
  };
}

export default {
  init,
  getInfo,
  searchComic,
  getRankingData,
  getRankingFilterBundle,
  getComicDetail,
  getReadSnapshot,
  getChapter,
  fetchImageBytes,
  getDownloadConcurrency,
  getSettingsBundle,
  onSettingChanged,
  getCapabilitiesBundle,
};
