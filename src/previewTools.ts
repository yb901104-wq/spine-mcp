import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtlasAttachmentLoader, FakeTexture, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { getAnimations, readSpineDocument, resolveWorkspacePath, validateSpineJson, type ToolContext } from "./spineJson.js";

export const PREVIEW_DEFAULTS = {
  baseUrl: "http://127.0.0.1:5177",
  defaultJson: "example-json/skeleton-4.1.json",
  defaultAtlas: "preview/xiaoren.atlas",
  defaultAnimation: "walktest2",
  runtimeMajorMinor: "4.1",
  runtimePackage: "@esotericsoftware/spine-player",
  runtimeVersion: "4.1.56",
  runtimeCorePackage: "@esotericsoftware/spine-core",
  runtimeCoreVersion: "4.1.56",
  premultipliedAlpha: true,
  mipmaps: false,
};

export interface PreviewUrlOptions {
  filePath?: string;
  atlasPath?: string;
  animation?: string;
  skin?: string;
  speed?: number;
  premultipliedAlpha?: boolean;
  mipmaps?: boolean;
  autoload?: boolean;
  baseUrl?: string;
}

export interface RuntimeValidationOptions {
  filePath?: string;
  atlasPath?: string;
  animation?: string;
  skin?: string;
  scale?: number;
}

export interface ValidationPipelineOptions extends RuntimeValidationOptions {
  baseUrl?: string;
  speed?: number;
  premultipliedAlpha?: boolean;
  mipmaps?: boolean;
  autoload?: boolean;
}

export function getPreviewConfig(baseUrl?: string) {
  return {
    ok: true,
    ...PREVIEW_DEFAULTS,
    baseUrl: normalizeBaseUrl(baseUrl),
    note: "预览 runtime 的 major.minor 必须匹配 JSON 的 skeleton.spine。当前样本是 4.1.24。",
    queryParameters: {
      json: "工作区内 Spine JSON 路径。",
      atlas: "工作区内 Spine atlas 路径。",
      animation: "要预览的动画名。",
      skin: "可选皮肤名，空字符串表示默认皮肤。",
      speed: "播放速度，默认 1。",
      pma: "是否使用预乘 Alpha，true/false。",
      mipmaps: "是否启用 mipmaps，true/false。",
      autoload: "页面打开后是否自动载入预览，true/false。",
    },
  };
}

export function getPreviewUrl(options: PreviewUrlOptions = {}) {
  const base = normalizeBaseUrl(options.baseUrl);
  const url = new URL(base);
  url.searchParams.set("json", options.filePath ?? PREVIEW_DEFAULTS.defaultJson);
  url.searchParams.set("atlas", options.atlasPath ?? PREVIEW_DEFAULTS.defaultAtlas);
  url.searchParams.set("animation", options.animation ?? PREVIEW_DEFAULTS.defaultAnimation);
  if (options.skin) url.searchParams.set("skin", options.skin);
  url.searchParams.set("speed", String(options.speed ?? 1));
  url.searchParams.set("pma", String(options.premultipliedAlpha ?? PREVIEW_DEFAULTS.premultipliedAlpha));
  url.searchParams.set("mipmaps", String(options.mipmaps ?? PREVIEW_DEFAULTS.mipmaps));
  url.searchParams.set("autoload", String(options.autoload ?? true));

  return {
    ok: true,
    url: url.toString(),
    baseUrl: base,
    params: Object.fromEntries(url.searchParams.entries()),
    message: "已生成浏览器预览链接。该链接只用于读取和播放资源，不会写入 JSON。",
  };
}

export async function checkPreviewAssets(
  args: {
    filePath?: string;
    atlasPath?: string;
    animation?: string;
  } = {},
  context: ToolContext = {},
) {
  const filePath = args.filePath ?? PREVIEW_DEFAULTS.defaultJson;
  const atlasPath = args.atlasPath ?? PREVIEW_DEFAULTS.defaultAtlas;
  const document = await readSpineDocument(filePath, context);
  const animations = getAnimations(document).animations.map((animation) => animation.name);
  const atlasAbsolutePath = resolveWorkspacePath(atlasPath, context);
  const atlasRaw = await readFile(atlasAbsolutePath, "utf8");
  const atlasPages = parseAtlasPages(atlasRaw);
  const atlasDir = normalizeDir(path.posix.dirname(normalizePath(atlasPath)));

  const imageChecks = [];
  for (const page of atlasPages) {
    const imagePath = atlasDir === "." ? page : `${atlasDir}/${page}`;
    const exists = await fileExists(imagePath, context);
    imageChecks.push({
      path: imagePath,
      exists,
    });
  }

  const requestedAnimation = args.animation ?? PREVIEW_DEFAULTS.defaultAnimation;
  const issues: string[] = [];
  if (!animations.includes(requestedAnimation)) issues.push(`动画 '${requestedAnimation}' 不存在。`);
  if (atlasPages.length === 0) issues.push("Atlas 中没有识别到贴图页。");
  for (const image of imageChecks) {
    if (!image.exists) issues.push(`Atlas 引用的贴图不存在：${image.path}`);
  }

  const atlasInfo = await stat(atlasAbsolutePath);
  return {
    ok: issues.length === 0,
    filePath,
    atlasPath,
    animation: requestedAnimation,
    version: document.json.skeleton?.spine ?? null,
    hash: document.hash,
    animationCount: animations.length,
    animationExists: animations.includes(requestedAnimation),
    atlas: {
      byteLength: atlasInfo.size,
      pageCount: atlasPages.length,
      pages: atlasPages,
    },
    images: imageChecks,
    recommendations: {
      premultipliedAlpha: PREVIEW_DEFAULTS.premultipliedAlpha,
      mipmaps: PREVIEW_DEFAULTS.mipmaps,
      note: "若切片边缘异常，请在预览页切换 pma；若相邻区域串色，请保持 mipmaps=false 并检查 atlas padding。",
    },
    issues,
  };
}

export async function validatePreviewRuntime(
  args: RuntimeValidationOptions = {},
  context: ToolContext = {},
) {
  const filePath = args.filePath ?? PREVIEW_DEFAULTS.defaultJson;
  const atlasPath = args.atlasPath ?? PREVIEW_DEFAULTS.defaultAtlas;
  const requestedAnimation = args.animation ?? PREVIEW_DEFAULTS.defaultAnimation;
  const requestedSkin = args.skin;
  const issues: string[] = [];

  const assetCheck = await checkPreviewAssets({ filePath, atlasPath, animation: requestedAnimation }, context);
  issues.push(...assetCheck.issues);

  const document = await readSpineDocument(filePath, context);
  const version = typeof document.json.skeleton?.spine === "string" ? document.json.skeleton.spine : null;
  const jsonMajorMinor = version ? getMajorMinor(version) : null;
  if (jsonMajorMinor !== PREVIEW_DEFAULTS.runtimeMajorMinor) {
    issues.push(`JSON 版本 ${version ?? "未知"} 与当前 runtime ${PREVIEW_DEFAULTS.runtimeVersion} 的 major.minor 不匹配。`);
  }

  try {
    const atlasRaw = await readFile(resolveWorkspacePath(atlasPath, context), "utf8");
    const atlas = new TextureAtlas(atlasRaw);
    for (const page of atlas.pages) {
      page.setTexture(new FakeTexture({ width: page.width, height: page.height } as any));
    }

    const skeletonJson = new SkeletonJson(new AtlasAttachmentLoader(atlas));
    if (args.scale !== undefined) {
      if (!Number.isFinite(args.scale) || args.scale <= 0) throw new Error("scale 必须是大于 0 的数字。");
      skeletonJson.scale = args.scale;
    }
    const skeletonData = skeletonJson.readSkeletonData(document.json);

    if (requestedAnimation && !skeletonData.findAnimation(requestedAnimation)) {
      issues.push(`runtime 未找到动画：${requestedAnimation}`);
    }
    if (requestedSkin && !skeletonData.findSkin(requestedSkin)) {
      issues.push(`runtime 未找到皮肤：${requestedSkin}`);
    }

    return {
      ok: issues.length === 0,
      filePath,
      atlasPath,
      animation: requestedAnimation,
      skin: requestedSkin ?? null,
      version,
      hash: document.hash,
      runtime: {
        package: PREVIEW_DEFAULTS.runtimeCorePackage,
        version: PREVIEW_DEFAULTS.runtimeCoreVersion,
        majorMinor: PREVIEW_DEFAULTS.runtimeMajorMinor,
      },
      assetCheck,
      skeletonData: {
        name: skeletonData.name,
        version: skeletonData.version,
        bones: skeletonData.bones.length,
        slots: skeletonData.slots.length,
        skins: skeletonData.skins.map((skin) => skin.name),
        animations: skeletonData.animations.map((animation) => ({
          name: animation.name,
          duration: animation.duration,
          timelineCount: animation.timelines.length,
        })),
        defaultSkin: skeletonData.defaultSkin?.name ?? null,
      },
      atlas: {
        pages: atlas.pages.map((page) => ({
          name: page.name,
          width: page.width,
          height: page.height,
          pma: page.pma,
          regionCount: page.regions.length,
        })),
        regionCount: atlas.regions.length,
      },
      issues,
      message: issues.length === 0
        ? "官方 spine-core runtime 已成功读取 JSON、atlas 和附件数据。"
        : "官方 spine-core runtime 能读取资源，但仍发现需要处理的问题。",
    };
  } catch (error) {
    return {
      ok: false,
      filePath,
      atlasPath,
      animation: requestedAnimation,
      skin: requestedSkin ?? null,
      version,
      hash: document.hash,
      runtime: {
        package: PREVIEW_DEFAULTS.runtimeCorePackage,
        version: PREVIEW_DEFAULTS.runtimeCoreVersion,
        majorMinor: PREVIEW_DEFAULTS.runtimeMajorMinor,
      },
      assetCheck,
      skeletonData: null,
      atlas: null,
      issues: [...issues, `官方 spine-core runtime 加载失败：${error instanceof Error ? error.message : String(error)}`],
      message: "官方 spine-core runtime 未能读取当前 JSON/atlas。请先恢复到最近一次确认可用的备份，再重新制作修改。",
    };
  }
}

export async function runValidationPipeline(
  args: ValidationPipelineOptions = {},
  context: ToolContext = {},
) {
  const filePath = args.filePath ?? PREVIEW_DEFAULTS.defaultJson;
  const atlasPath = args.atlasPath ?? PREVIEW_DEFAULTS.defaultAtlas;
  const animation = args.animation ?? PREVIEW_DEFAULTS.defaultAnimation;
  const document = await readSpineDocument(filePath, context);
  const structureValidation = validateSpineJson(document.json);
  const runtimeValidation = await validatePreviewRuntime({
    filePath,
    atlasPath,
    animation,
    skin: args.skin,
    scale: args.scale,
  }, context);
  const previewUrl = getPreviewUrl({
    filePath,
    atlasPath,
    animation,
    skin: args.skin,
    speed: args.speed,
    premultipliedAlpha: args.premultipliedAlpha,
    mipmaps: args.mipmaps,
    autoload: args.autoload,
    baseUrl: args.baseUrl,
  });

  const checks = [
    {
      name: "spine_validate_json",
      ok: structureValidation.ok,
      note: "结构、引用关系、关键帧排序和官方 timeline 子集审查。",
    },
    {
      name: "spine_runtime_validate",
      ok: runtimeValidation.ok,
      note: "官方 spine-core runtime 读取 JSON、atlas 和附件数据。",
    },
    {
      name: "spine_preview_get_url",
      ok: previewUrl.ok,
      note: "生成浏览器预览链接，不写入 JSON。",
    },
  ];
  const ok = checks.every((check) => check.ok);

  return {
    ok,
    filePath,
    atlasPath,
    animation,
    skin: args.skin ?? null,
    version: document.json.skeleton?.spine ?? null,
    hash: document.hash,
    checks,
    structureValidation,
    runtimeValidation,
    previewUrl,
    recommendedNextSteps: ok
      ? [
        "打开 previewUrl.url 进行人工动作观感确认。",
        "如果动作需要调整，回到 dryRun -> 写入 -> 本验证流水线的闭环。",
      ]
      : [
        "不要继续在错误 JSON 上叠加修改。",
        "优先查看 structureValidation.issues 和 runtimeValidation.issues。",
        "如果 Spine 软件也导入失败，恢复最近一次确认可导入的备份后重新制作。",
      ],
    message: ok
      ? "推荐验证流水线已通过：结构校验、官方 runtime 读取和预览入口都可用。"
      : "推荐验证流水线未通过。请先处理 issues；若真实导入失败，按备份恢复流程重新制作。",
  };
}

function parseAtlasPages(atlasRaw: string) {
  const lines = atlasRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pages: string[] = [];
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index].includes(":") && lines[index + 1].startsWith("size:")) {
      pages.push(lines[index]);
    }
  }
  return [...new Set(pages)];
}

async function fileExists(filePath: string, context: ToolContext) {
  try {
    const absolutePath = resolveWorkspacePath(filePath, context);
    const info = await stat(absolutePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function normalizeBaseUrl(baseUrl?: string) {
  return `${(baseUrl ?? process.env.SPINE_PREVIEW_BASE_URL ?? PREVIEW_DEFAULTS.baseUrl).replace(/\/+$/, "")}/`;
}

function normalizePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function normalizeDir(dir: string) {
  return dir === "" ? "." : dir;
}

function getMajorMinor(version: string) {
  const match = version.match(/^(\d+\.\d+)/);
  return match ? match[1] : version;
}
