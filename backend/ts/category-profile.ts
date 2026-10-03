/**
 * 品类档案表（批次 2）—— 品类 → 构图模板 / 背景风格 / 场景描述 / device 位是否保留。
 *
 * 依据《电商生成流水线品类化与商品图上传改造执行计划》：
 *  - 手机壳 = 手持特写浅景深（唯一保留 device 位的品类）
 *  - 服装 = 上身或平铺
 *  - 饰品 = 微距摆拍
 *  - 通用 = 产品置于场景中央（无品类落通用模板）
 * 品类来源：商品上传时商家点选为主，对话 LLM 读图推断兜底（lib/products.js inferCategory）。
 */

export type CategoryKey = 'phone_case' | 'apparel' | 'jewelry' | 'generic';

export const CATEGORY_KEYS: CategoryKey[] = ['phone_case', 'apparel', 'jewelry', 'generic'];

/** 品类中文标签（前端点选/日志用，与 lib/products.js CATEGORIES 同键） */
export const CATEGORY_LABEL_CN: Record<CategoryKey, string> = {
  phone_case: '手机壳',
  apparel: '服装',
  jewelry: '饰品',
  generic: '通用',
};

export interface CategoryProfile {
  /** device（机型）位是否保留——仅手机壳保留，其余品类不得出现 iPhone 等机型词 */
  keep_device: boolean;
  /** 文生图是否带人像（ demographics）——服装上身带模特；饰品/通用为摆拍不出现人物 */
  keep_demographic: boolean;
  /** 构图模板短句（中文，替换旧「手持特写浅景深」写死构图） */
  composition: string;
  /** 图生图场景替换指令（批次 3 requestWanxEdit 用；配方：保持产品完全不变 + 去画面文字 + 背景替换） */
  edit_scene: string;
  /** Pollinations 英文兜底场景（替代旧整句写死手机壳的兜底 prompt） */
  en_scene: string;
}

const PROFILES: Record<CategoryKey, CategoryProfile> = {
  phone_case: {
    keep_device: true,
    keep_demographic: true,
    composition: '手持特写浅景深',
    edit_scene: '保持图中手机壳产品完全不变，去掉画面中的所有文字与水印，将背景替换为干净柔和的摄影棚光背景，手机壳置于画面中央完整清晰展示',
    en_scene: 'a person holding a smartphone with the case on, close-up shot with shallow depth of field',
  },
  apparel: {
    keep_device: false,
    keep_demographic: true,
    composition: '模特上身展示或平铺构图',
    edit_scene: '保持图中服装的版型、颜色与细节完全不变，去掉画面中的所有文字与水印，以模特上身展示或平整铺放的方式呈现，背景替换为简洁的摄影棚背景',
    en_scene: 'the apparel worn by a model or neatly flat-laid, fashion editorial photography',
  },
  jewelry: {
    keep_device: false,
    keep_demographic: false,
    composition: '微距摆拍特写',
    edit_scene: '保持图中首饰的形态、材质与光泽完全不变，去掉画面中的所有文字与水印，以微距摆拍特写呈现质感，背景替换为干净的石纹或丝绒台面',
    en_scene: 'macro still-life jewelry photography on a clean elegant surface',
  },
  generic: {
    keep_device: false,
    keep_demographic: false,
    composition: '产品置于场景中央',
    edit_scene: '保持图中产品外观完全不变，去掉画面中的所有文字与水印，将产品置于画面中央完整展示，背景替换为干净的高级生活方式场景',
    en_scene: 'the product placed at the center of a clean premium lifestyle scene',
  },
};

/** 归一化品类键：兼容中文/别名/大小写；未知/空 → ''（调用方落通用模板） */
export function normalizeCategory(v: unknown): CategoryKey | '' {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (['phone_case', 'phonecase', 'phone case', '手机壳', 'case'].includes(s)) return 'phone_case';
  if (['apparel', 'clothing', '服装', '衣服', 'fashion'].includes(s)) return 'apparel';
  if (['jewelry', 'jewellery', '饰品', '首饰', 'accessory'].includes(s)) return 'jewelry';
  if (['generic', 'other', '通用', 'general'].includes(s)) return 'generic';
  return '';
}

/** 取品类档案（未知/空 → 通用模板，与计划「无品类落通用模板」一致） */
export function categoryProfile(category: unknown): CategoryProfile {
  const key = normalizeCategory(category) || 'generic';
  return PROFILES[key];
}
