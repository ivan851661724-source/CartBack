/**
 * mailgen 请求 payload schema（zod）
 * 端口自 Python scripts/mailgen.py 的 stdin JSON 契约。
 * 所有字段可选（兼容旧版），未知字段透传保留（from_plan_card 需要原始方案卡字段）。
 */
import { z } from 'zod';

export const AiConfigSchema = z
  .object({
    provider: z.string().optional(),
    aiProvider: z.string().optional(),
    apiKey: z.string().optional(),
    key: z.string().optional(),
    baseUrl: z.string().optional(),
    aiBaseUrl: z.string().optional(),
    model: z.string().optional(),
    aiModel: z.string().optional(),
    visionKey: z.string().optional(),
    wanxKey: z.string().optional(),
    visionBaseUrl: z.string().optional(),
    wanxBaseUrl: z.string().optional(),
    visionModel: z.string().optional(),
    wanxModel: z.string().optional(),
  })
  .passthrough();

export const DraftSchema = z
  .object({
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    brand: z.string().optional(),
    cart_url: z.string().optional(),
    locale: z.string().optional(),
    preferred_language: z.string().optional(),
    discount: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export const MailgenPayloadSchema = z
  .object({
    subject: z.string().optional(),
    body: z.string().optional(),
    discount: z.union([z.number(), z.string()]).optional(),
    brand: z.string().optional(),
    audience: z.string().optional(),
    cart_url: z.string().optional(),
    cta: z.string().optional(),
    locale: z.string().optional(),
    product_en: z.string().optional(),
    product: z.string().optional(),
    product_cn: z.string().optional(),
    coupon: z.string().optional(),
    posters: z.array(z.unknown()).optional(),
    preferred_language: z.string().optional(),
    force_regen_copy: z.boolean().optional(),
    skip_image: z.boolean().optional(),
    product_image_path: z.string().optional(),
    ai_config: AiConfigSchema.optional(),
    draft: DraftSchema.optional(),
  })
  .passthrough();

export type MailgenPayload = z.infer<typeof MailgenPayloadSchema>;
