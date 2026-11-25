// Cào catalog dreamland.vn qua WooCommerce Store API công khai + WP REST API.
// Chạy:  node scripts/sync/scrape-full.mjs [--full] [--resume] [--limit N]
//        [--out data/products.json] [--state data/sync-state.json]
// Mặc định: CHẠY TĂNG DẦN — chỉ cào lại SP có `modified` đổi (lấy từ
//   WP REST API /wp-json/wp/v2/product) hoặc SP mới, còn lại dùng lại
//   từ data/products.json. Store API KHÔNG trả date_modified nên không
//   dùng nó làm tín hiệu (đã kiểm tra live 25/11/2026).
//   --full: cào toàn bộ, bỏ qua sync-state + checkpoint.
//   --resume: chỉ dùng với --full — chạy tiếp từ checkpoint jsonl khi
//     lần chạy full trước bị dừng giữa chừng (chạy tăng dần mặc định đã
//     tự tiếp tục được vì sync-state chưa cập nhật).
//   --limit N: chỉ cào lại tối đa N SP thay đổi — CHỈ ĐỂ THỬ, phải dùng
//     kèm --out tới file tạm, nếu không sẽ ghi đè products.json thật.
//   --out: ghi products.json ra file khác (mặc định data/products.json).
// Kết quả: data/products.json (bare array, schema everon.site),
//   data/categories.json, data/run-stats.json, data/sync-state.json
//   (tổng số + map product_modified để lần sau chạy tăng dần).
// Checkpoint: data/products.full.jsonl (1 SP / dòng) + data/discovery.json.
//   2 file này chỉ dùng trong lúc chạy — workflow xoá trước khi mở PR.
// Không tải ảnh — chỉ ghi source_url + src dự kiến (workflow sync tải sau).
// Quy tắc gộp SP trùng (quyết của anh 25/11/2026): xem MERGED_PRODUCTS.
// SP giữ lại dù không còn trên nguồn (quyết của anh 25/11/2026): xem data/keep-products.json.
// SP giá 0 được phép: xem data/zero-price-allowed.json (71 SP hàng trưng bày).
// Node 18+ (dùng fetch toàn cục), không cần cài thêm thư viện.

import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_BASE = 'https://dreamland.vn/wp-json/wc/store/v1';
const WP_API_BASE = 'https://dreamland.vn/wp-json/wp/v2';
const OUT_FILE = resolve(ROOT, 'data', 'products.json');
const CATS_FILE = resolve(ROOT, 'data', 'categories.json');
const STATS_FILE = resolve(ROOT, 'data', 'run-stats.json');
const JSONL_FILE = resolve(ROOT, 'data', 'products.full.jsonl');
const DISCOVERY_FILE = resolve(ROOT, 'data', 'discovery.json');
const STATE_FILE = resolve(ROOT, 'data', 'sync-state.json');
const ALLOWLIST_FILE = resolve(ROOT, 'data', 'zero-price-allowed.json');
const KEEP_FILE = resolve(ROOT, 'data', 'keep-products.json');
const DELAY_MS = 150; // nghỉ giữa các lần gọi API
const CONCURRENCY = 5; // số lần gọi biến thể chạy song song
const TIMEOUT_MS = 30000;
const RETRIES = 3;

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const eq = args.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
  if (eq !== undefined) return eq;
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const FULL = args.includes('--full');
const RESUME = args.includes('--resume');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;
const OUT_PATH = resolve(ROOT, argVal('--out', 'data/products.json'));
const STATE_PATH = resolve(ROOT, argVal('--state', 'data/sync-state.json'));

const startedAt = Date.now();
let apiCalls = 0;
const skipped = [];
const warnings = [];
const variantCollisions = []; // biến thể trùng tổ hợp thuộc tính trong cùng SP
const mediaDeduped = []; // ảnh trùng source_url trong cùng SP (chỉ giữ 1)

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
};

// Giải mã HTML entities (số thập phân, hexa, tên thường gặp).
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (_, n) => NAMED_ENTITIES[n] ?? `&${n};`);
}

// CSS trần (không nằm trong thẻ <style>): các rule #banner-... và @media...
// lọt vào mô tả dưới dạng text — gỡ bằng cách đếm ngoặc cân bằng.
function stripBareCss(s) {
  let out = s;
  for (;;) {
    const m = out.search(/#banner-\d+|@media\b/);
    if (m === -1) break;
    const i = out.indexOf('{', m);
    if (i === -1) { out = out.slice(0, m); break; }
    let depth = 0, j = i;
    for (; j < out.length; j++) {
      if (out[j] === '{') depth++;
      else if (out[j] === '}') { depth--; if (depth === 0) break; }
    }
    out = out.slice(0, m) + ' ' + out.slice(j + 1);
  }
  return out;
}

// Bỏ thẻ HTML, giữ lại text thuần (cho description của WooCommerce).
// Lưu ý: mô tả nguồn chứa cả CSS của banner — một phần trong khối <style>,
// một phần là text trần (#banner-... / @media...) — phải bỏ cả hai,
// nếu không CSS sẽ lọt vào text.
function stripHtml(s) {
  if (!s) return '';
  return decodeEntities(stripBareCss(String(s)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')))
    .replace(/[ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      apiCalls++;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(t);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`BLOCKED HTTP ${res.status} ${url} — API chặn truy cập, dừng chạy`);
      }
      if (res.status === 429) {
        const wait = 5000 * attempt;
        console.log(`  [429] đợi ${wait / 1000}s rồi thử lại (${url})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const data = await res.json();
      return { data, headers: res.headers };
    } catch (err) {
      lastErr = err;
      if (err.message.includes('BLOCKED')) throw err;
      if (attempt < RETRIES) await sleep(DELAY_MS * attempt * 5);
    }
  }
  throw lastErr;
}

// Chạy các task với tối đa CONCURRENCY task cùng lúc.
async function pool(tasks, worker) {
  const results = new Array(tasks.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await worker(tasks[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

const money = (v) => ({ amount: Number.parseInt(v, 10) || 0, currency: 'VND' });
const discountOf = (price, regular) => (regular > price ? Math.round((1 - price / regular) * 100) : 0);
const today = () => new Date().toISOString().slice(0, 10);

// ---------- 1. cây danh mục ----------

async function fetchCategories() {
  const byId = new Map();
  const list = [];
  let page = 1;
  for (;;) {
    const { data, headers } = await fetchJson(`${API_BASE}/products/categories?per_page=100&page=${page}`);
    for (const c of data) {
      byId.set(c.id, { id: c.id, slug: c.slug, name: decodeEntities(c.name), parent: c.parent });
      list.push(c);
    }
    const totalPages = Number(headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages || data.length === 0) break;
    page++;
    await sleep(DELAY_MS);
  }
  return { byId, list };
}

// Trả về slug của danh mục gốc (parent = 0) cho 1 category id.
function topAncestorSlug(catId, byId) {
  let cur = byId.get(catId);
  const seen = new Set();
  while (cur && cur.parent !== 0 && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parent);
  }
  return cur ? cur.slug : null;
}

// ---------- 2. danh sách toàn bộ sản phẩm ----------

async function fetchProducts() {
  const out = [];
  const seenIds = new Set();
  let page = 1;
  for (;;) {
    const { data, headers } = await fetchJson(`${API_BASE}/products?per_page=100&page=${page}`);
    for (const p of data) {
      if (seenIds.has(p.id)) {
        skipped.push(`Trang ${page}: trùng product id ${p.id} (${p.slug}) — bỏ qua bản trùng`);
        continue;
      }
      seenIds.add(p.id);
      out.push(p);
    }
    const totalPages = Number(headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages || data.length === 0) break;
    page++;
    await sleep(DELAY_MS);
  }
  return out;
}

// ---------- 2b. map modified (WP REST API) — tín hiệu chạy tăng dần ----------
// Store API không trả date_modified (đã kiểm tra live 25/11/2026), nên lấy
// `modified` từ WP REST API /wp/v2/product (công khai, không cần auth).
// Sitemap product-sitemap.xml cũng có <lastmod> nhưng thiếu ~4 SP nên
// không dùng làm tín hiệu chính. Lưu ý: `modified` đổi khi SP được lưu
// trong admin (kèm biến thể của nó); quét toàn bộ Chủ nhật là lưới an toàn.
async function fetchModifiedMap() {
  const out = {};
  let page = 1;
  for (;;) {
    const { data, headers } = await fetchJson(
      `${WP_API_BASE}/product?per_page=100&page=${page}&_fields=id,slug,modified`,
    );
    for (const p of data) if (p.slug && p.modified) out[p.slug] = p.modified;
    const totalPages = Number(headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages || data.length === 0) break;
    page++;
    await sleep(DELAY_MS);
  }
  return out;
}

// ---------- 2c. gộp SP trùng (quyết của anh 25/11/2026) ----------
// chan-long-chon và chan-long-chon-02 trùng tên + trùng giá 4.260.000đ.
// Gộp thành 1 SP: giữ chan-long-chon, 1 biến thể 210x230
// (CHAN-LONG-CHON-210-X-230-CM), ảnh gộp 4 + 5 = 9 (không trùng source_url).
const MERGED_PRODUCTS = [
  {
    keep: 'chan-long-chon',
    absorbed: 'chan-long-chon-02',
    decided_at: '2026-11-25',
    reason: 'Trùng tên + trùng giá 4.260.000đ; ảnh gộp 4 + 5 = 9 ảnh.',
  },
];

// ---------- 2d. giữ SP theo data/keep-products.json ----------
// Quyết của anh 25/11/2026: 4 SP không còn trên nguồn (hqb-05,
// goi-om-mat-ca-ngua, gm-06, cm28) vẫn giữ trên web. File keep-products.json
// là danh sách id cần giữ — muốn giữ thêm SP nào thì thêm id vào đó, không
// cần sửa code. Trả về [] nếu file thiếu/hỏng — sync chạy như cũ.
function loadKeptSlugs(keepFile) {
  try {
    const raw = JSON.parse(readFileSync(keepFile, 'utf8'));
    const list = raw.products ?? raw.kept ?? raw;
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter((s) => typeof s === 'string' && s))];
  } catch {
    return [];
  }
}

// Chèn các SP trong keep-list (không còn trên nguồn) từ products.json cũ
// vào `out`, đúng vị trí cũ để giữ thứ tự catalog. Trả về danh sách slug
// đã khôi phục. SP nào nguồn có lại thì đã nằm trong `out` (bản mới),
// không chèn lại bản cũ. SP trong keep-list mà không có trong file cũ
// thì ghi vào `skipped` (cảnh báo, không fail).
function restoreKeptProducts(out, oldBySlug, oldOrder, keptSlugs) {
  const restored = [];
  const outSlugs = new Set(out.map((p) => p.slug));
  for (const slug of oldOrder) {
    if (!keptSlugs.includes(slug)) continue;
    if (outSlugs.has(slug)) continue;
    const old = oldBySlug.get(slug);
    if (!old) continue;
    const before = oldOrder.slice(0, oldOrder.indexOf(slug)).filter((s) => outSlugs.has(s)).length;
    out.splice(before, 0, old);
    outSlugs.add(slug);
    restored.push(slug);
  }
  for (const slug of keptSlugs) {
    if (!oldBySlug.has(slug) && !outSlugs.has(slug)) {
      skipped.push(`keep-list: ${slug} không có trong products.json cũ — không khôi phục được`);
    }
  }
  return restored;
}

function applyMerges(products, prevMerged = []) {
  // Gộp SP trùng theo MERGED_PRODUCTS. Phải chạy đúng qua nhiều lần sync:
  // - Lần đầu (full): keep.media là ảnh gốc, gộp thêm ảnh của drop.
  // - Lần sau (tăng dần): keep trong products.json đã gộp rồi. Muốn ảnh
  //   của drop cập nhật đúng khi nguồn đổi, phải bỏ ảnh đã gộp lần trước
  //   (theo snapshot absorbed_media_source_urls trong sync-state) rồi mới
  //   gộp ảnh mới của drop. Chỉ cộng dồn sẽ làm ảnh cũ còn sót lại.
  // - Nếu drop không có trong đợt này (không đổi): keep đã gộp rồi, bỏ qua.
  // - Nếu keep được cào mới mà drop không có: main() phải luôn cào kèm
  //   drop khi cào keep (xem phần tính todo), nếu không ảnh gộp sẽ mất.
  const log = [];
  const nextMerged = [];
  for (const rule of MERGED_PRODUCTS) {
    const keep = products.find((p) => p.id === rule.keep);
    const drop = products.find((p) => p.id === rule.absorbed);
    const prev = prevMerged.find((m) => m.keep === rule.keep && m.absorbed === rule.absorbed);
    const oldAbsorbedUrls = new Set(prev?.absorbed_media_source_urls ?? []);
    if (!keep) throw new Error(`gộp SP: không tìm thấy ${rule.keep}`);
    if (!drop) {
      nextMerged.push({ ...rule, absorbed_media_source_urls: [...oldAbsorbedUrls] });
      continue; // SP bị gộp không đổi — bản đã gộp giữ nguyên.
    }
    if (keep.name !== drop.name || keep.price.amount !== drop.price.amount) {
      throw new Error(`gộp SP: ${rule.keep} và ${rule.absorbed} không còn trùng tên/giá — dừng lại để anh quyết lại`);
    }
    const baseMedia = keep.media.filter((m) => !oldAbsorbedUrls.has(m.source_url));
    const mergedMedia = [
      ...baseMedia,
      ...drop.media.map((m, i) => ({
        ...m,
        role: 'gallery',
        src: `assets/img/products/${rule.keep}/img-${baseMedia.length + 1 + i}.webp`,
      })),
    ];
    const srcs = mergedMedia.map((m) => m.source_url);
    if (new Set(srcs).size !== srcs.length) {
      throw new Error(`gộp SP: ảnh của ${rule.keep} và ${rule.absorbed} có source_url trùng nhau`);
    }
    keep.media = mergedMedia;
    products.splice(products.indexOf(drop), 1);
    nextMerged.push({ ...rule, absorbed_media_source_urls: drop.media.map((m) => m.source_url) });
    log.push({ ...rule, merged_images: mergedMedia.length });
  }
  return { log, nextMerged };
}

// ---------- 2d. danh sách SP giá 0 được phép ----------
// 71 SP hàng trưng bày/không bán (is_purchasable=false), anh chốt GIỮ LẠI
// hiện "Liên hệ" (25/11/2026). File này commit cùng repo; giá 0 ngoài
// danh sách là lỗi (validate chặn, xem scripts/sync/validate.mjs).
function loadZeroPriceAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
    return new Set(raw.allowed_zero_price_product_ids ?? []);
  } catch {
    return new Set();
  }
}
const ZERO_PRICE_ALLOWED = loadZeroPriceAllowlist();

// ---------- 3. map sang schema everon.site (y hệt bản thử) ----------

function termName(product, attrName, slugValue) {
  const attr = (product.attributes || []).find((a) => a.name === attrName);
  const term = attr?.terms?.find((t) => t.slug === slugValue);
  if (term) return term.name;
  return String(slugValue).replace(/-/g, ' ').trim();
}

function mapVariant(product, variation, varDetail) {
  const attrs = variation.attributes || []; // [{name, value}] — value là slug
  const sizeAttr = attrs.find((a) => a.name === 'Kích thước');
  const otherAttrs = attrs.filter((a) => a.name !== 'Kích thước');
  const size = sizeAttr ? termName(product, 'Kích thước', sizeAttr.value) : null;
  const setType = otherAttrs.length
    ? otherAttrs.map((a) => `${a.name} ${termName(product, a.name, a.value)}`).join(' · ')
    : null;
  const skuParts = [product.slug, ...attrs.map((a) => a.value)];
  const sku = skuParts.join('-').toUpperCase();
  const prices = varDetail.prices || {};
  const price = money(prices.price);
  const regular = money(prices.regular_price);
  return {
    sku,
    size,
    set_type: setType,
    price,
    compare_at_price: regular,
    discount_percent: discountOf(price.amount, regular.amount),
    status: varDetail.is_in_stock ? 'active' : 'out_of_stock',
    stock: null, // Store API không trả số lượng tồn, chỉ có is_in_stock
    _vid: varDetail.id, // tạm, để xử lý trùng SKU — xoá trước khi ghi file
  };
}

function mapProduct(product, varDetails, categoriesById) {
  const id = product.slug;
  const sku = decodeEntities(product.sku || '') || null;
  const name = decodeEntities(product.name || '');
  const prices = product.prices || {};

  // category_ids: slug các danh mục được gán + slug danh mục gốc của chúng.
  const categoryIds = [];
  for (const c of product.categories || []) {
    if (c.slug && !categoryIds.includes(c.slug)) categoryIds.push(c.slug);
    const top = topAncestorSlug(c.id, categoriesById);
    if (top && !categoryIds.includes(top)) categoryIds.push(top);
  }

  // Trục biến thể (Kích thước, Độ Dày...) để trang chi tiết render bộ chọn.
  const variationAxes = (product.attributes || [])
    .filter((a) => a.has_variations)
    .map((a) => ({ name: a.name, values: (a.terms || []).map((t) => t.name) }));

  let variants;
  if (product.type === 'variable') {
    variants = varDetails.map((vd) => {
      const v = (product.variations || []).find((x) => x.id === vd.id);
      return mapVariant(product, v || { id: vd.id, attributes: [] }, vd);
    });
    // Nguồn có thể có 2 biến thể cùng tổ hợp thuộc tính nhưng khác giá
    // (vd HQB-05: Ga chun 160x200 có 2 biến thể 680.000đ và 650.000đ).
    // SKU sinh từ thuộc tính sẽ trùng — thêm hậu tố -V<variation_id> cho
    // biến thể trùng sau để giữ đủ dữ liệu mà SKU vẫn duy nhất trong SP.
    const seenSku = new Map();
    for (const mv of variants) {
      if (seenSku.has(mv.sku)) {
        const first = seenSku.get(mv.sku);
        const base = mv.sku;
        mv.sku = `${base}-V${mv._vid}`;
        variantCollisions.push({
          product: id,
          base_sku: base,
          kept_sku: first.sku,
          kept_variation_id: first._vid,
          kept_price: first.price.amount,
          renamed_sku: mv.sku,
          renamed_variation_id: mv._vid,
          renamed_price: mv.price.amount,
        });
      } else {
        seenSku.set(mv.sku, mv);
      }
    }
    for (const mv of variants) delete mv._vid;
  } else {
    const price = money(prices.price);
    const regular = money(prices.regular_price);
    variants = [{
      sku: sku ? sku.toUpperCase() : id.toUpperCase(),
      size: null,
      set_type: null,
      price,
      compare_at_price: regular,
      discount_percent: discountOf(price.amount, regular.amount),
      status: product.is_in_stock ? 'active' : 'out_of_stock',
      stock: null,
    }];
  }

  // Ảnh trùng source_url trong cùng SP (vd cotton-modal-moc-06 có 1 URL 2 lần):
  // chỉ giữ 1, tránh 2 file local giống hệt nhau sau này.
  const seenImgSrc = new Set();
  const uniqImages = (product.images || []).filter((img) => {
    if (!img.src || seenImgSrc.has(img.src)) {
      if (img.src) mediaDeduped.push({ product: id, source_url: img.src });
      return false;
    }
    seenImgSrc.add(img.src);
    return true;
  });
  const media = uniqImages.map((img, i) => ({
    type: 'image',
    role: i === 0 ? 'cover' : 'gallery',
    src: `assets/img/products/${id}/${i === 0 ? 'cover' : `img-${i + 1}`}.webp`,
    source_url: img.src,
    alt: decodeEntities(img.alt || '') || name,
    width: null, // Store API không trả kích thước ảnh gốc
    height: null,
  }));

  const price = money(prices.price);
  const regular = money(prices.regular_price);
  return {
    id,
    sku,
    slug: product.slug,
    name,
    category_ids: categoryIds,
    collection_ids: [],
    description: stripHtml(product.description) || stripHtml(product.short_description) || '',
    attributes: {
      material: null,
      colors: [],
      pattern: null,
      pattern_type: null,
      origin: null,
      set_types: [],
      variation_axes: variationAxes,
    },
    variants,
    media,
    price,
    compare_at_price: regular,
    discount_percent: discountOf(price.amount, regular.amount),
    local_override: null,
    source: { site: 'dreamland.vn', url: product.permalink, updated_at: today() },
    synced_at: new Date().toISOString(),
    status: product.is_in_stock ? 'active' : 'out_of_stock',
  };
}

// ---------- 4. validator (nội bộ scraper) ----------
// Giá 0 chỉ được phép với 71 SP trong data/zero-price-allowed.json
// (hàng trưng bày, anh chốt giữ lại hiện "Liên hệ"). Biến thể giá 0 lẻ
// (vd OL-01..06 có vài cỡ chưa nhập giá, SP vẫn bán được) chỉ cảnh báo.
// SP không ảnh (26 SP, anh chốt giữ lại) chỉ cảnh báo — web hiện
// ảnh placeholder (xem README gói PR).
function validate(products) {
  const errors = [];
  const warns = [];
  const seenIds = new Set();
  for (const p of products) {
    if (!p.id) errors.push(`SP thiếu id (name=${p.name})`);
    if (seenIds.has(p.id)) errors.push(`Trùng id: ${p.id}`);
    seenIds.add(p.id);
    if (!p.name) errors.push(`SP ${p.id}: thiếu name`);
    if (!p.slug) errors.push(`SP ${p.id}: thiếu slug`);
    const zeroAllowed = ZERO_PRICE_ALLOWED.has(p.id);
    if (!Number.isInteger(p.price?.amount) || (p.price.amount <= 0 && !zeroAllowed)) {
      errors.push(`SP ${p.id}: price.amount không hợp lệ (${p.price?.amount})`);
    }
    if (!Number.isInteger(p.compare_at_price?.amount) || (p.compare_at_price.amount <= 0 && !zeroAllowed)) {
      errors.push(`SP ${p.id}: compare_at_price.amount không hợp lệ (${p.compare_at_price?.amount})`);
    }
    if (!p.variants?.length) errors.push(`SP ${p.id}: không có biến thể`);
    const seenVarSku = new Set();
    for (const v of p.variants || []) {
      if (!v.sku) errors.push(`SP ${p.id}: biến thể thiếu sku`);
      if (seenVarSku.has(v.sku)) errors.push(`SP ${p.id}: trùng sku biến thể ${v.sku}`);
      seenVarSku.add(v.sku);
      if (!Number.isInteger(v.price?.amount) || v.price.amount < 0) {
        errors.push(`SP ${p.id} / ${v.sku}: giá biến thể không hợp lệ (${v.price?.amount})`);
      } else if (v.price.amount === 0 && !zeroAllowed) {
        warns.push(`SP ${p.id} / ${v.sku}: biến thể giá 0 (SP vẫn bán được, chỉ cỡ này chưa có giá)`);
      }
      if (!Number.isInteger(v.compare_at_price?.amount) || v.compare_at_price.amount < 0) {
        errors.push(`SP ${p.id} / ${v.sku}: giá gốc biến thể không hợp lệ`);
      }
    }
    if (!p.media?.length) warns.push(`SP ${p.id}: không có ảnh (giữ lại theo quyết 25/11/2026, web hiện ảnh placeholder)`);
    const seenImg = new Set();
    for (const m of p.media || []) {
      if (!m.source_url) errors.push(`SP ${p.id}: ảnh thiếu source_url`);
      if (seenImg.has(m.source_url)) errors.push(`SP ${p.id}: trùng ảnh ${m.source_url}`);
      seenImg.add(m.source_url);
    }
    if (!p.sku) warns.push(`SP ${p.id}: sku gốc rỗng (dùng slug làm id)`);
    if (!p.description) warns.push(`SP ${p.id}: description rỗng`);
    if (p.media?.length === 1) warns.push(`SP ${p.id}: chỉ có 1 ảnh`);
    if (p.discount_percent > 0) warns.push(`SP ${p.id}: đang sale ${p.discount_percent}%`);
  }
  // Cặp trùng phải luôn được gộp — nếu chan-long-chon-02 còn riêng là lỗi.
  if (seenIds.has('chan-long-chon-02')) {
    errors.push('SP chan-long-chon-02: chưa gộp với chan-long-chon (xem MERGED_PRODUCTS)');
  }
  return { errors, warns };
}

// ---------- 5. phân tích bất thường ----------

function analyze(rawProducts, mapped) {
  const slugSet = new Set(rawProducts.map((p) => p.slug));
  const bySlug = new Map(rawProducts.map((p) => [p.slug, p]));

  // Slug hậu tố -2: có slug gốc tương ứng không? Có SP cùng tên khác slug không?
  const minus2 = [];
  const nameGroups = new Map();
  for (const p of rawProducts) {
    const name = decodeEntities(p.name || '').trim();
    if (!nameGroups.has(name)) nameGroups.set(name, []);
    nameGroups.get(name).push(p.slug);
  }
  for (const p of rawProducts) {
    if (!p.slug.endsWith('-2')) continue;
    const base = p.slug.slice(0, -2);
    const sameName = nameGroups.get(decodeEntities(p.name || '').trim()) || [];
    minus2.push({
      slug: p.slug,
      name: decodeEntities(p.name || ''),
      base_slug_exists: slugSet.has(base),
      base_slug: slugSet.has(base) ? base : null,
      same_name_slugs: sameName,
      duplicate_name: sameName.length > 1,
    });
  }
  const duplicateNames = [...nameGroups.entries()]
    .filter(([, slugs]) => slugs.length > 1)
    .map(([name, slugs]) => ({ name, slugs }));

  const noImage = mapped.filter((p) => !p.media.length).map((p) => ({ id: p.id, name: p.name }));
  const noSku = mapped.filter((p) => !p.sku).map((p) => ({ id: p.id, name: p.name }));
  const outOfStock = mapped.filter((p) => p.status === 'out_of_stock').map((p) => ({ id: p.id, name: p.name }));
  const onSale = mapped.filter((p) => p.discount_percent > 0).map((p) => ({
    id: p.id, name: p.name, discount_percent: p.discount_percent,
  }));
  const zeroPrice = mapped.filter((p) => p.price.amount <= 0).map((p) => ({ id: p.id, name: p.name }));

  return { minus2, duplicateNames, noImage, noSku, outOfStock, onSale, zeroPrice };
}

// ---------- main ----------

async function main() {
  const mode = FULL ? 'full' : 'incremental';
  console.log(`Cào catalog dreamland.vn — chế độ: ${mode}${RESUME ? ' + --resume' : ''} ...`);
  if (RESUME && !FULL) {
    console.log('- Lưu ý: --resume chỉ có tác dụng với --full; chạy tăng dần mặc định đã tự tiếp tục được.');
  }
  if (LIMIT > 0 && OUT_PATH === OUT_FILE) {
    console.error('NGUY HIỂM: --limit mà không có --out sẽ ghi đè products.json thật bằng dữ liệu thiếu.');
    console.error('  Dùng: node scripts/sync/scrape-full.mjs --limit 3 --out /tmp/test-products.json');
    process.exit(2);
  }

  const { byId: categoriesById, list: categoriesRaw } = await fetchCategories();
  console.log(`- Danh mục: ${categoriesById.size} mục (X-WP-Total báo 127, thực tế ${categoriesById.size})`);

  // Ghi categories.json theo đúng shape everon.site.
  const slugById = new Map([...categoriesById.values()].map((c) => [c.id, c.slug]));
  const catsOut = {
    categories: categoriesRaw.map((c) => ({
      id: c.slug,
      name: decodeEntities(c.name || ''),
      parent_id: c.parent === 0 ? null : (slugById.get(c.parent) || null),
      product_count_on_source: c.count,
      slug: c.slug,
      source_url: c.permalink || null,
    })),
    synced_at: new Date().toISOString(),
  };
  mkdirSync(dirname(CATS_FILE), { recursive: true });
  writeFileSync(CATS_FILE, JSON.stringify(catsOut, null, 2) + '\n');
  console.log(`- Ghi ${CATS_FILE} (${catsOut.categories.length} danh mục)`);

  // Map modified (WP REST API) — tín hiệu chạy tăng dần.
  const modifiedMap = await fetchModifiedMap();
  console.log(`- Map modified (WP REST API): ${Object.keys(modifiedMap).length} SP`);

  const rawProducts = await fetchProducts();
  console.log(`- Sản phẩm toàn catalog: ${rawProducts.length}`);

  // Discovery: thứ tự SP để ráp products.json sau (kèm modified).
  const discovery = {
    total: rawProducts.length,
    products: rawProducts.map((p) => ({ id: p.id, slug: p.slug, type: p.type, variations: (p.variations || []).length, modified: modifiedMap[p.slug] ?? null })),
    started_at: new Date(startedAt).toISOString(),
  };
  writeFileSync(DISCOVERY_FILE, JSON.stringify(discovery, null, 2) + '\n');

  // Dữ liệu cũ (để dùng lại SP không đổi) + sync-state cũ (map modified).
  let prevProducts = [];
  let prevModified = {};
  if (!FULL && existsSync(OUT_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
      prevProducts = Array.isArray(raw) ? raw : raw.products ?? [];
    } catch { prevProducts = []; }
  }
  if (!FULL && existsSync(STATE_PATH)) {
    try { prevModified = JSON.parse(readFileSync(STATE_PATH, 'utf8')).product_modified ?? {}; } catch { prevModified = {}; }
  }
  const prevBySlug = new Map(prevProducts.map((p) => [p.slug, p]));

  // SP giữ lại theo keep-list: đọc riêng products.json + sync-state cũ.
  // Chạy --full không nạp prevProducts/prevModified nên không dùng lại
  // 2 biến đó được; chạy tăng dần thì đọc lại cùng 2 file (rẻ, 1 lần).
  const keptSlugs = loadKeptSlugs(KEEP_FILE);
  let oldBySlug = new Map();
  let oldOrder = [];
  let oldModified = {};
  if (keptSlugs.length) {
    try {
      const rawOld = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
      const oldProducts = Array.isArray(rawOld) ? rawOld : rawOld.products ?? [];
      oldBySlug = new Map(oldProducts.map((p) => [p.slug, p]));
      oldOrder = oldProducts.map((p) => p.slug);
    } catch { /* không có file cũ: keep-list không khôi phục được */ }
    try { oldModified = JSON.parse(readFileSync(STATE_PATH, 'utf8')).product_modified ?? {}; } catch { /* bỏ qua */ }
  }

  // Tính danh sách cần cào lại.
  // SP bị gộp (absorbed) không còn riêng trong products.json — không tính
  // là "SP mới" chỉ vì vắng mặt; chỉ cào lại khi modified của nó đổi.
  // Và khi cào keep thì luôn cào kèm absorbed (nếu không ảnh gộp sẽ mất
  // khi keep được cào mới mà absorbed không có trong đợt).
  const absorbedSlugs = new Set(MERGED_PRODUCTS.map((m) => m.absorbed));
  let todo;
  if (FULL) {
    todo = rawProducts;
    console.log('- --full: cào toàn bộ, bỏ qua sync-state + checkpoint.');
  } else {
    todo = rawProducts.filter((p) => {
      if (absorbedSlugs.has(p.slug)) {
        return (modifiedMap[p.slug] ?? null) !== (prevModified[p.slug] ?? null);
      }
      if (!prevBySlug.has(p.slug)) return true; // SP mới
      return (modifiedMap[p.slug] ?? null) !== (prevModified[p.slug] ?? null);
    });
    for (const rule of MERGED_PRODUCTS) {
      const keepInTodo = todo.some((p) => p.slug === rule.keep);
      const absorbedInTodo = todo.some((p) => p.slug === rule.absorbed);
      if (keepInTodo && !absorbedInTodo) {
        const absorbed = rawProducts.find((p) => p.slug === rule.absorbed);
        if (absorbed) todo.push(absorbed);
      }
    }
    console.log(`- Chạy tăng dần: ${todo.length}/${rawProducts.length} SP thay đổi/mới, dùng lại ${rawProducts.length - todo.length} SP.`);
  }
  if (LIMIT > 0) {
    todo = todo.slice(0, LIMIT);
    console.log(`- Giới hạn --limit ${LIMIT}: chỉ cào lại ${todo.length} SP (ghi ra ${OUT_PATH})`);
  }

  // Checkpoint jsonl: chỉ dùng khi --full --resume (chạy full bị dừng giữa chừng).
  // Các chế độ khác không đọc checkpoint — chạy tăng dần tự tiếp tục được vì
  // sync-state chưa cập nhật cho SP cào lỗi.
  mkdirSync(dirname(JSONL_FILE), { recursive: true });
  const fresh = new Map();
  if (FULL && RESUME && existsSync(JSONL_FILE)) {
    for (const line of readFileSync(JSONL_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line);
        fresh.set(p.id, p);
      } catch { /* bỏ qua dòng hỏng */ }
    }
    console.log(`- --resume: đã có ${fresh.size} SP trong checkpoint`);
  } else {
    writeFileSync(JSONL_FILE, '');
  }

  const failedSlugs = new Set();
  let processed = 0;
  for (const p of todo) {
    if (fresh.has(p.slug)) { processed++; continue; }
    const label = `${p.slug} (id=${p.id})`;
    try {
      let varDetails = [];
      if (p.type === 'variable') {
        const ids = (p.variations || []).map((v) => v.id);
        varDetails = await pool(ids, async (vid) => {
          const { data } = await fetchJson(`${API_BASE}/products/${vid}`);
          await sleep(DELAY_MS);
          return data;
        });
        const got = varDetails.filter(Boolean).length;
        if (got !== ids.length) {
          skipped.push(`${label}: chỉ lấy được ${got}/${ids.length} biến thể`);
        }
      }
      const mapped = mapProduct(p, varDetails.filter(Boolean), categoriesById);
      appendFileSync(JSONL_FILE, JSON.stringify(mapped) + '\n');
      fresh.set(mapped.id, mapped);
    } catch (err) {
      skipped.push(`${label}: LỖI ${err.message} — dùng lại dữ liệu cũ (nếu có)`);
      failedSlugs.add(p.slug);
      if (err.message.includes('BLOCKED')) throw err;
    }
    processed++;
    if (processed % 50 === 0) {
      const el = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);
      console.log(`  ... ${processed}/${todo.length} SP, ${apiCalls} API calls, ${el} phút`);
    }
    await sleep(DELAY_MS);
  }

  // Ráp products.json theo đúng thứ tự discovery: SP cào mới lấy bản mới,
  // SP không đổi (hoặc cào lỗi) lấy bản cũ; SP không còn trên nguồn thì bỏ.
  const out = [];
  const removed = [];
  for (const d of discovery.products) {
    const p = fresh.get(d.slug) ?? prevBySlug.get(d.slug);
    if (p) out.push(p);
  }
  for (const p of prevBySlug.values()) {
    if (!discovery.products.some((d) => d.slug === p.slug)) removed.push(p.slug);
  }
  // SP trong keep-list: giữ lại từ products.json cũ (dữ liệu + ảnh cũ).
  // `removed` chỉ tính SP bị gỡ thật (keep-list đã khôi phục thì không tính).
  const keptRestored = restoreKeptProducts(out, oldBySlug, oldOrder, keptSlugs);
  if (keptRestored.length) {
    console.log(`- SP giữ lại theo keep-list (không còn trên nguồn): ${keptRestored.join(', ')}`);
    for (let i = removed.length - 1; i >= 0; i--) {
      if (keptRestored.includes(removed[i])) removed.splice(i, 1);
    }
  }
  if (removed.length) console.log(`- SP không còn trên nguồn (bỏ khỏi catalog): ${removed.join(', ')}`);

  // Gộp SP trùng theo quyết của anh (dùng snapshot ảnh đã gộp lần trước
  // trong sync-state để ảnh cập nhật đúng khi nguồn đổi).
  const prevMerged = (() => {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')).merged_products ?? []; } catch { return []; }
  })();
  const { log: mergedLog, nextMerged } = applyMerges(out, prevMerged);
  if (mergedLog.length) console.log(`- Gộp SP trùng: ${mergedLog.map((m) => `${m.absorbed} → ${m.keep} (${m.merged_images} ảnh)`).join(', ')}`);

  const { errors, warns } = validate(out);
  const analysis = analyze(rawProducts, out);

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  const totalVariants = out.reduce((n, p) => n + p.variants.length, 0);
  const totalImages = out.reduce((n, p) => n + p.media.length, 0);
  const priceAmounts = out.map((p) => p.price.amount).filter((a) => a > 0);
  const varPrices = out.flatMap((p) => p.variants.map((v) => v.price.amount)).filter((a) => a > 0);
  const stats = {
    mode,
    products: out.length,
    products_total_on_source: rawProducts.length,
    products_skipped: todo.length - fresh.size,
    products_reused: out.length - fresh.size,
    products_rescraped: fresh.size,
    products_removed: removed,
    variants: totalVariants,
    images: totalImages,
    price_range_product: priceAmounts.length ? [Math.min(...priceAmounts), Math.max(...priceAmounts)] : [0, 0],
    price_range_variant: varPrices.length ? [Math.min(...varPrices), Math.max(...varPrices)] : [0, 0],
    api_calls: apiCalls,
    categories: catsOut.categories.length,
    skipped,
    errors,
    warnings: [...warns, ...warnings],
    variant_collisions: variantCollisions,
    media_deduped: mediaDeduped,
    merged_products: mergedLog,
    analysis,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
  };
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2) + '\n');

  // Cập nhật sync-state.json: tổng số + map modified mới (để lần sau chạy
  // tăng dần). SP cào lỗi giữ lại modified cũ để lần sau cào lại.
  // --limit là chế độ thử: KHÔNG cập nhật sync-state (tránh ghi nhận SP
  // chưa được cào lại là "đã đồng bộ").
  if (LIMIT > 0) {
    console.log('- --limit: không cập nhật sync-state.json (chỉ để thử).');
  } else {
    const nextModified = { ...modifiedMap };
    for (const slug of failedSlugs) {
      if (prevModified[slug] !== undefined) nextModified[slug] = prevModified[slug];
    }
    // SP giữ lại: giữ nguyên modified cũ để lần sau còn vết (nguồn không
    // trả modified cho SP này nữa nên không có trong modifiedMap).
    for (const slug of keptRestored) {
      if (oldModified[slug] !== undefined) nextModified[slug] = oldModified[slug];
    }
    const nextState = {
      schema_version: 1,
      last_run_at: new Date().toISOString(),
      source: {
        site: 'dreamland.vn',
        api: 'https://dreamland.vn/wp-json/wc/store/v1/products',
        modified_api: 'https://dreamland.vn/wp-json/wp/v2/product?_fields=id,slug,modified',
        sitemap_url: 'https://dreamland.vn/product-sitemap.xml',
      },
      totals: {
        products: out.length,
        variants: totalVariants,
        images: totalImages,
        out_of_stock: out.filter((p) => p.status === 'out_of_stock').length,
        zero_price_allowed: out.filter((p) => p.price.amount === 0).length,
      },
      product_modified: nextModified,
      merged_products: nextMerged,
      note: 'product_modified: ngày giờ sửa cuối (modified) của từng SP trên nguồn, lấy từ WP REST API /wp/v2/product (Store API không trả date_modified). Sync tăng dần chỉ cào lại SP có modified đổi hoặc SP mới; Chủ nhật hoặc --full thì cào toàn bộ. Sitemap product-sitemap.xml có lastmod nhưng thiếu ~4 SP nên không dùng làm tín hiệu chính. merged_products.absorbed_media_source_urls là snapshot ảnh đã gộp — lần sau bỏ đúng các ảnh này rồi gộp lại ảnh mới của SP bị gộp.',
    };
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');
  }

  console.log(`- Sản phẩm ghi được: ${out.length}/${rawProducts.length}, biến thể: ${totalVariants}, ảnh: ${totalImages}`);
  console.log(`- API calls: ${apiCalls}, thời gian: ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} phút`);
  console.log(`- Không ảnh: ${analysis.noImage.length} | Không SKU: ${analysis.noSku.length} | Hết hàng: ${analysis.outOfStock.length} | Sale: ${analysis.onSale.length} | Slug -2: ${analysis.minus2.length} | Tên trùng: ${analysis.duplicateNames.length} | Trùng biến thể: ${variantCollisions.length}`);
  if (skipped.length) console.log(`- BỎ QUA (${skipped.length}):\n  ${skipped.join('\n  ')}`);
  if (errors.length) console.log(`- LỖI (${errors.length}):\n  ${errors.slice(0, 40).join('\n  ')}${errors.length > 40 ? `\n  ... và ${errors.length - 40} lỗi nữa` : ''}`);
  console.log(`- Cảnh báo: ${stats.warnings.length}`);
  console.log(`- Ghi ${OUT_PATH}${LIMIT > 0 ? ' (sync-state.json không cập nhật vì --limit)' : ` + ${STATE_PATH}`}`);
}

main().catch((err) => {
  console.error('LỖI CHẠY:', err.message);
  process.exit(1);
});
