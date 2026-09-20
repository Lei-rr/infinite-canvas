import { assertPrompt, generateImageBatch } from "../lib/engine.mjs";
import { badRequest } from "../lib/errors.mjs";
import { config } from "../config.mjs";

// POST /v1/images/generations
export async function handleGenerate({ body }) {
  const prompt = assertPrompt(body.prompt);
  const model = String(body.model || config.defaultModel || "").trim();
  const count = Number(body.n ?? body.count ?? 1);
  const images = await generateImageBatch({ model, prompt, size: body.size, count });
  return { created: Math.floor(Date.now() / 1000), data: images.map((url) => ({ url })) };
}

// POST /v1/images/edits（multipart，参考图统一转成 dataURL 交给渠道）
export async function handleEdits(ctx) {
  const formData = await toFormData(ctx.req);
  const prompt = assertPrompt(formData.get("prompt"));
  const model = String(formData.get("model") || config.defaultModel || "").trim();
  const count = Number(formData.get("n") || 1);
  const refImages = [];

  for (const [key, value] of formData.entries()) {
    if ((key === "image" || key === "image[]") && typeof value === "object" && typeof value.arrayBuffer === "function") {
      const buffer = Buffer.from(await value.arrayBuffer());
      refImages.push({ type: "image_url", image_url: { url: `data:${value.type || "image/png"};base64,${buffer.toString("base64")}` } });
    }
  }
  if (!refImages.length) throw badRequest("缺少参考图 image 字段", "MISSING_REFERENCE");

  const images = await generateImageBatch({ model, prompt, size: formData.get("size") || "", refImages, count });
  return { created: Math.floor(Date.now() / 1000), data: images.map((url) => ({ url })) };
}

async function toFormData(req) {
  const { Readable } = await import("node:stream");
  const request = new Request("http://bff.local" + req.url, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
  try {
    return await request.formData();
  } catch {
    throw badRequest("请求体不是合法 multipart 表单", "INVALID_FORM_DATA");
  }
}
