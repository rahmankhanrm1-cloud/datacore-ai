import { bytesToBase64, requestError } from "./workspace.js";

const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-dev";
const VIDEO_MODEL = "bytedance/seedance-2.0";
const IMAGE_DIMENSIONS = {
  square: [1024, 1024],
  landscape: [1280, 720],
  portrait: [720, 1280],
};
const PHOTO_DIRECTION = "Photographic realism: physically plausible lighting, natural textures and proportions, believable materials, and realistic depth of field.";

export async function imageDataUrl(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 4 * 1024 * 1024) {
    throw requestError("Use a JPG, PNG or WebP image under 4 MB.");
  }
  return `data:${file.type};base64,${bytesToBase64(await file.arrayBuffer())}`;
}

export async function generateImage(env, { prompt, file, format, style }) {
  const [width, height] = Object.hasOwn(IMAGE_DIMENSIONS, format) ? IMAGE_DIMENSIONS[format] : IMAGE_DIMENSIONS.square;
  const form = new FormData();
  const edit = file ? "Use reference image 0. Preserve the subject, composition and identity except where the requested edits require changes." : "";
  const photo = style === "creative" ? "" : PHOTO_DIRECTION;
  form.set("prompt", [prompt || "Improve the reference naturally.", edit, photo].filter(Boolean).join("\n"));
  form.set("width", String(width));
  form.set("height", String(height));
  form.set("steps", "28");
  if (file) form.set("input_image_0", file, file.name);
  const encoded = new Response(form);
  let response;
  try {
    response = await env.AI.run(IMAGE_MODEL, { multipart: { body: encoded.body, contentType: encoded.headers.get("content-type") } });
  } catch {
    throw requestError("The image provider could not complete this request. Try a different prompt or reference image.", 502);
  }
  const image = response?.image ?? response?.result?.image;
  if (typeof image !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw requestError("The image provider did not return a usable image.", 502);
  const mime = image.startsWith("iVBORw0KGgo") ? "png" : image.startsWith("UklGR") ? "webp" : image.startsWith("/9j/") ? "jpeg" : null;
  if (!mime) throw requestError("The image provider returned an unsupported format.", 502);
  return `data:image/${mime};base64,${image}`;
}

export async function generateVideo(env, { prompt, file, format, style }) {
  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";
  const input = {
    prompt: [
      prompt || "Animate the reference image with subtle natural movement.",
      file && "Maintain the reference subject, setting and composition as the opening frame.",
      style !== "creative" && "Use realistic motion and physically consistent lighting. Keep subjects stable across frames.",
    ].filter(Boolean).join("\n"),
    duration: 5,
    resolution: "1080p",
    aspect_ratio: aspectRatio,
  };
  if (file) input.image = await imageDataUrl(file);
  const options = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
  let response;
  try {
    response = await env.AI.run(VIDEO_MODEL, input, options);
  } catch (error) {
    if (/billing|credit|payment|unified|gateway|permission|entitlement/i.test(String(error?.message))) {
      throw requestError("Video generation requires Cloudflare AI Gateway access and Unified Billing.", 503, "VIDEO_BILLING_REQUIRED");
    }
    throw requestError("The video provider could not complete this request. Try a shorter prompt or a different reference image.", 502);
  }
  const video = response?.result?.video ?? response?.video;
  if (typeof video !== "string" || !/^https:\/\//i.test(video)) {
    throw requestError("The video provider did not return a playable video.", 502);
  }
  return video;
}
