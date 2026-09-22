import axios from "axios";
import sharp from "sharp";
import { isNsfwQuery } from "../data/nsfw-blocklist.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const PLACEHOLDER_HASHES = new Set([
  "d53b014d86a6b6761bf649a0ed813c2b",
]);

const axiosBrowser = axios.create({
  timeout: 15_000,
  headers: {
    "User-Agent": UA,
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  },
  validateStatus: (s) => s >= 200 && s < 400,
});

function unique(urls) {
  return [...new Set(urls.filter(Boolean))];
}

function isPlaceholderUrl(url) {
  const hash = String(url).match(/\/([a-f0-9]{32})\./i)?.[1]?.toLowerCase();
  return Boolean(hash && PLACEHOLDER_HASHES.has(hash));
}

function preferLargerPinUrl(url) {
  return String(url).replace(/\/(?:\d+x)\//, "/736x/");
}

function pinUrlFromResult(pin) {
  const images = pin?.images || {};
  return (
    images.orig?.url ||
    images["736x"]?.url ||
    images["564x"]?.url ||
    images["474x"]?.url ||
    images["236x"]?.url ||
    null
  );
}

async function searchApi(query) {
  console.log(`📌 pinterest API search "${query}"`);
  const { data } = await axiosBrowser.get(
    "https://www.pinterest.com/resource/BaseSearchResource/get/",
    {
      params: {
        source_url: `/search/pins/?q=${query}&rs=typed`,
        data: JSON.stringify({
          options: {
            query,
            scope: "pins",
            auto_correction_disabled: false,
            rs: "typed",
            page_size: 20,
          },
          context: {},
        }),
      },
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`,
        "X-Pinterest-PWS-Handler": "www/search/[scope].js",
      },
    },
  );

  const results = data?.resource_response?.data?.results;
  if (!Array.isArray(results)) {
    console.log("📌 pinterest API: no results array");
    return [];
  }

  const urls = unique(
    results
      .filter((pin) => !pin?.videos)
      .map(pinUrlFromResult)
      .filter((url) => typeof url === "string" && /^https:\/\/i\.pinimg\.com\//.test(url))
      .filter((url) => !isPlaceholderUrl(url))
      .map(preferLargerPinUrl),
  );
  console.log(`📌 pinterest API urls: ${urls.length}`);
  return urls;
}

async function searchBing(query) {
  const { data: html } = await axiosBrowser.get("https://www.bing.com/images/search", {
    params: { q: `${query} site:pinterest.com`, form: "HDRSC2" },
    headers: { Accept: "text/html" },
  });
  const matches = [
    ...(String(html).matchAll(
      /https:\/\/i\.pinimg\.com\/[a-zA-Z0-9/_-]+\.(?:jpg|jpeg|png|webp)/gi,
    ) || []),
  ].map((m) => m[0]);
  const urls = unique(
    matches.filter((url) => !isPlaceholderUrl(url)).map(preferLargerPinUrl),
  );
  console.log(`📌 bing pin urls: ${urls.length}`);
  return urls;
}

function mimetypeFromMeta(format) {
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return "image/jpeg";
}

export async function downloadImage(url) {
  console.log(`📌 downloading ${url}`);
  const { data } = await axiosBrowser.get(url, {
    responseType: "arraybuffer",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/jpeg,image/png,image/*,*/*;q=0.8",
      Referer: "https://www.pinterest.com/",
    },
    maxContentLength: 8 * 1024 * 1024,
  });
  const raw = Buffer.from(data);
  const head = raw.subarray(0, 32).toString("utf8").toLowerCase();
  if (head.includes("<!doctype") || head.includes("<html") || head.includes("<?xml")) {
    throw new Error("not_image");
  }
  if (raw.length < 20_000) throw new Error("too_small");

  const meta = await sharp(raw).metadata();
  if (!meta.width || !meta.height || meta.width < 220 || meta.height < 220) {
    throw new Error("too_small");
  }

  const format = String(meta.format || "").toLowerCase();
  console.log(
    `📌 downloaded ${url} ${raw.length}B ${meta.width}x${meta.height} ${format}`,
  );
  if (format === "jpeg" || format === "jpg" || format === "png") {
    return { buffer: raw, mimetype: mimetypeFromMeta(format) };
  }

  const buffer = await sharp(raw).rotate().jpeg({ quality: 90 }).toBuffer();
  return { buffer, mimetype: "image/jpeg" };
}

export async function searchPinterestPin(query) {
  if (!query?.trim()) throw new Error("empty");
  if (isNsfwQuery(query)) throw new Error("nsfw");

  const sources = [searchApi, searchBing];
  let urls = [];
  for (const source of sources) {
    try {
      urls = await source(query);
      if (urls.length) break;
    } catch (err) {
      console.error("📌 pin search error:", err.message);
    }
  }

  if (!urls.length) throw new Error("not_found");

  const picks = urls.slice(0, 12).sort(() => Math.random() - 0.5);
  let lastErr = new Error("not_found");
  for (const pick of picks) {
    try {
      const image = await downloadImage(pick);
      return { ...image, url: pick, query };
    } catch (err) {
      console.warn(`📌 skip ${pick}: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr.message === "not_image" || lastErr.message === "too_small"
    ? new Error("not_found")
    : lastErr;
}
