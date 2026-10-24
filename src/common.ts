import type {
  ActionItem,
  ComicListItem,
  ImageItem,
  MetadataListItem,
  StringMap,
} from "breeze-plugin-kit";

/** 插件唯一标识，务必保持稳定 */
export const PLUGIN_ID = "3f8a2c71-5d94-4e6b-b0a3-7c1e9d4f2a68";

export const API_BASE = "https://api.mangadex.org";
export const UPLOADS_BASE = "https://uploads.mangadex.org";

/** MangaDex 要求每个请求都带可识别的 User-Agent */
export const USER_AGENT = "BreezePlugin-MangaDex/1.0 (Breeze manga reader plugin)";

/** 占位图：必须是合法非空 URL */
export const PLACEHOLDER_IMAGE_URL = `${UPLOADS_BASE}/covers/placeholder.png`;

export const PAGE_SIZE = 20;

/** 常用语言，MangaDex 用 BCP-47 风格代码 */
export const LANGUAGES: ReadonlyArray<{ value: string; name: string }> = [
  { value: "en", name: "英语" },
  { value: "zh", name: "中文" },
  { value: "zh-hk", name: "繁体中文" },
  { value: "ja", name: "日语" },
  { value: "ko", name: "韩语" },
  { value: "es", name: "西班牙语" },
  { value: "es-la", name: "拉美西语" },
  { value: "fr", name: "法语" },
  { value: "pt-br", name: "葡语（巴西）" },
  { value: "ru", name: "俄语" },
  { value: "de", name: "德语" },
  { value: "it", name: "意大利语" },
  { value: "id", name: "印尼语" },
  { value: "vi", name: "越南语" },
  { value: "th", name: "泰语" },
  { value: "ar", name: "阿拉伯语" },
];

export const STATUS_MAP: Record<string, string> = {
  ongoing: "连载中",
  completed: "已完结",
  hiatus: "休载",
  cancelled: "已取消",
};

export function decodeEntities(input: string): string {
  if (!input || input.indexOf("&") < 0) {
    return input;
  }
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function cleanText(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return decodeEntities(input).replace(/[\s\u3000]+/g, " ").trim();
}

export function absoluteUrl(raw: string | null | undefined): string {
  const value = cleanText(raw);
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  return `${API_BASE}/${value.replace(/^\//, "")}`;
}

export function createImage(input: {
  id?: string;
  url?: string;
  name?: string;
  path?: string;
  extern?: StringMap;
} = {}): ImageItem {
  const url = cleanText(input.url);
  return {
    id: String(input.id ?? ""),
    url: url || PLACEHOLDER_IMAGE_URL,
    name: String(input.name ?? ""),
    path: String(input.path ?? "").trim() || "cover/placeholder.png",
    extern: input.extern ?? {},
  };
}

export function createActionItem(name: string, extern: StringMap = {}): ActionItem {
  return {
    name: cleanText(name),
    onTap: null,
    extern,
  };
}

export function createMetadata(
  type: string,
  name: string,
  values: ReadonlyArray<string>,
): MetadataListItem {
  return {
    type,
    name,
    value: values
      .map((item) => cleanText(item))
      .filter((item) => item.length > 0)
      .map((item) => createActionItem(item)),
  };
}

/** 从 MangaDex 的本地化对象里挑最佳文本 */
export function pickLocalized(
  map: Record<string, string> | null | undefined,
  preferred: string[],
): string {
  if (!map) {
    return "";
  }
  for (const key of preferred) {
    const value = map[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const value of Object.values(map)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

export type MdRelationship = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
};

export type MdManga = {
  id: string;
  type: string;
  attributes: {
    title: Record<string, string>;
    altTitles?: Array<Record<string, string>>;
    description?: Record<string, string>;
    status?: string;
    year?: number | null;
    tags?: Array<{ attributes: { name: Record<string, string> } }>;
    contentRating?: string;
    lastChapter?: string | null;
    originalLanguage?: string;
  };
  relationships: MdRelationship[];
};

/** 从 relationships 里取指定类型的名字列表 */
export function relationshipNames(manga: MdManga, type: string): string[] {
  return (manga.relationships ?? [])
    .filter((rel) => rel.type === type)
    .map((rel) => cleanText(rel.attributes?.name))
    .filter((name) => name.length > 0);
}

/** 封面 URL 规则：/covers/{mangaId}/{fileName}.{size}.jpg */
export function coverUrl(manga: MdManga, size: 256 | 512 | 256 | 512 = 512): string {
  const cover = (manga.relationships ?? []).find((rel) => rel.type === "cover_art");
  const fileName = cleanText(cover?.attributes?.fileName);
  if (!fileName) {
    return "";
  }
  return `${UPLOADS_BASE}/covers/${manga.id}/${fileName}.${size}.jpg`;
}

export function mangaTitle(manga: MdManga, preferred: string[] = ["zh", "zh-hk", "en", "ja"]): string {
  return pickLocalized(manga.attributes?.title, preferred) || `未命名-${manga.id.slice(0, 8)}`;
}

export function mangaDescription(manga: MdManga, preferred: string[] = ["zh", "zh-hk", "en"]): string {
  return pickLocalized(manga.attributes?.description, preferred);
}

/** 把 MdManga 转成列表条目 */
export function toComicListItem(manga: MdManga): ComicListItem {
  const title = mangaTitle(manga);
  const author = relationshipNames(manga, "author")[0] ?? "";
  const status = STATUS_MAP[manga.attributes?.status ?? ""] ?? "";
  const cover = coverUrl(manga);

  return {
    source: PLUGIN_ID,
    id: manga.id,
    title,
    subtitle: [author, status].filter(Boolean).join(" · "),
    finished: manga.attributes?.status === "completed",
    likesCount: 0,
    viewsCount: 0,
    updatedAt: "",
    cover: createImage({
      id: manga.id,
      url: cover,
      name: title,
      path: `comic/${manga.id}/cover.jpg`,
      extern: {},
    }),
    metadata: [
      createMetadata("author", "作者", relationshipNames(manga, "author")),
      createMetadata(
        "categories",
        "标签",
        (manga.attributes?.tags ?? []).slice(0, 6).map((tag) => pickLocalized(tag.attributes.name, ["zh", "en"])),
      ),
    ],
    raw: {
      id: manga.id,
      title,
      status: manga.attributes?.status ?? "",
      year: manga.attributes?.year ?? null,
      contentRating: manga.attributes?.contentRating ?? "",
      originalLanguage: manga.attributes?.originalLanguage ?? "",
    },
    extern: {},
  };
}
