// validate.mjs — Kiểm tra file JSON catalog DreamLand theo schema everon.site.
// Node.js 18+, không dependency.
//   node scripts/sync/validate.mjs [đường-dẫn-file-json]
//     [--allowlist data/zero-price-allowed.json]
//     [--manifest data/image-manifest.json] [--prev data/products.json.cu]
// Mặc định: data/products.json (bản mảng trần).
// --allowlist: danh sách SP giá 0 được phép (71 SP hàng trưng bày, anh chốt
//   GIỮ LẠI hiện "Liên hệ" ngày 25/11/2026). Giá 0 ngoài danh sách là lỗi.
// --manifest: đối chiếu từng media.src với manifest ảnh (manifest ghi theo
//   local_path; entry.source_url phải trùng media.source_url, file phải tồn tại).
// --prev: safety gate — chặn nếu catalog mất >10% so với bản trước
//   hoặc có giá âm / giá 0 ngoài allowlist.
// Lỗi (fail) -> exit 1. Cảnh báo (thiếu mô tả/màu/chất liệu, SP không ảnh,
// biến thể giá 0 lẻ) chỉ liệt kê, không fail — vì nguồn thật sự không có.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--')) ?? 'data/products.json';
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
  if (eq !== undefined) return eq;
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const allowlistFile = opt('--allowlist') ?? 'data/zero-price-allowed.json';
const manifestFile = opt('--manifest');
const prevFile = opt('--prev');
const raw = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
const products = Array.isArray(raw) ? raw : raw.products ?? [];
const errors = [];
const warnings = [];

// SP giá 0 được phép (hàng trưng bày, anh chốt giữ lại hiện "Liên hệ").
let zeroAllowed = new Set();
try {
  const allow = JSON.parse(readFileSync(resolve(ROOT, allowlistFile), 'utf8'));
  zeroAllowed = new Set(allow.allowed_zero_price_product_ids ?? []);
} catch {
  warnings.push(`allowlist: không đọc được ${allowlistFile} — coi như không có SP giá 0 nào được phép`);
}

// Ảnh tự lưu: media.src là đường dẫn ảnh WebP trong repo
// (vd: assets/img/products/tp-12/cover.webp). Thư mục phải trùng
// với id sản phẩm, tên file cover.webp hoặc img-<số>.webp; nếu
// chuyển WebP thất bại, images.mjs giữ định dạng gốc (.jpg/.png)
// và cập nhật lại src — cả hai đều hợp lệ.
const SRC_RE = /^assets\/img\/products\/[a-z0-9-]+\/(cover|img-\d+)\.(webp|jpg|jpeg|png)$/;

if (!Array.isArray(products) || products.length === 0) errors.push('không có sản phẩm nào');

const seenIds = new Set();
let noMaterial = 0;
let noColors = 0;
for (const p of products) {
  const tag = p.id ?? p.slug ?? '?';
  for (const f of ['id', 'slug', 'name']) if (!p[f] || typeof p[f] !== 'string') errors.push(`${tag}: thiếu ${f}`);
  if (p.sku !== null && p.sku !== undefined && typeof p.sku !== 'string') errors.push(`${tag}: sku sai kiểu`);
  if (seenIds.has(p.id)) errors.push(`${tag}: trùng id sản phẩm`);
  seenIds.add(p.id);
  const zeroOk = zeroAllowed.has(p.id);
  if (!p.price || !Number.isInteger(p.price?.amount) || p.price.amount < 0) {
    errors.push(`${tag}: giá không hợp lệ (${p.price?.amount})`);
  } else if (p.price.amount === 0 && !zeroOk) {
    errors.push(`${tag}: giá = 0 mà không nằm trong danh sách cho phép (data/zero-price-allowed.json)`);
  }
  if (!p.compare_at_price || !Number.isInteger(p.compare_at_price?.amount) || p.compare_at_price.amount < 0) {
    errors.push(`${tag}: giá gốc không hợp lệ (${p.compare_at_price?.amount})`);
  } else if (p.compare_at_price.amount === 0 && !zeroOk) {
    errors.push(`${tag}: giá gốc = 0 mà không nằm trong danh sách cho phép`);
  }
  if (p.compare_at_price?.amount < p.price?.amount) errors.push(`${tag}: giá gốc nhỏ hơn giá bán`);
  if (!(p.discount_percent >= 0 && p.discount_percent <= 100)) errors.push(`${tag}: discount_percent ngoài 0-100`);
  if (p.local_override !== null && p.local_override !== undefined) errors.push(`${tag}: local_override phải null (đã chốt dùng giá dreamland.vn)`);
  if (!Array.isArray(p.category_ids) || p.category_ids.length === 0) errors.push(`${tag}: category_ids rỗng`);
  if (!Array.isArray(p.variants) || p.variants.length === 0) errors.push(`${tag}: không có biến thể nào`);
  else {
    const seenVarSku = new Set();
    for (const v of p.variants) {
      if (!v.sku || typeof v.sku !== 'string') errors.push(`${tag}: biến thể thiếu sku`);
      if (seenVarSku.has(v.sku)) errors.push(`${tag}: trùng sku biến thể ${v.sku}`);
      seenVarSku.add(v.sku);
      if (!Number.isInteger(v.price?.amount) || v.price.amount < 0) {
        errors.push(`${tag}: biến thể ${v.sku} giá không hợp lệ (${v.price?.amount})`);
      } else if (v.price.amount === 0 && !zeroOk) {
        warnings.push(`${tag}: biến thể ${v.sku} giá 0 (SP vẫn bán được, chỉ cỡ này chưa có giá trên nguồn)`);
      }
      if (!Number.isInteger(v.compare_at_price?.amount) || v.compare_at_price.amount < 0) {
        errors.push(`${tag}: biến thể ${v.sku} giá gốc không hợp lệ`);
      }
    }
  }
  if (!Array.isArray(p.media)) errors.push(`${tag}: thiếu media`);
  else if (p.media.length === 0) {
    warnings.push(`${tag}: không có ảnh (giữ lại theo quyết 25/11/2026, web hiện ảnh placeholder)`);
  } else for (const m of p.media) {
    if (!m.source_url?.startsWith('https://dreamland.vn/')) errors.push(`${tag}: ảnh source_url không phải dreamland.vn`);
    if (!m.src || typeof m.src !== 'string') errors.push(`${tag}: ảnh thiếu src (đường dẫn ảnh tự lưu)`);
    else {
      if (!SRC_RE.test(m.src)) errors.push(`${tag}: ảnh src sai định dạng: ${m.src}`);
      const dir = m.src.split('/')[3];
      if (dir && p.id && dir !== p.id) errors.push(`${tag}: ảnh src thư mục ${dir} khác id sản phẩm ${p.id}`);
    }
  }
  if (!p.source?.url?.startsWith('https://dreamland.vn/san-pham/')) errors.push(`${tag}: source.url không phải trang sản phẩm dreamland.vn`);
  if (!p.description) warnings.push(`${tag}: thiếu mô tả (nguồn không có)`);
  if (p.status === 'out_of_stock') warnings.push(`${tag}: hết hàng`);
  if (!p.attributes?.material) noMaterial++;
  if (!(p.attributes?.colors ?? []).length) noColors++;
}
// Nguồn DreamLand không có trường chất liệu/màu cho bất kỳ SP nào —
// gom thành 1 cảnh báo tổng, không cảnh báo từng SP (sẽ thành 500+ dòng nhiễu).
if (noMaterial > 0) warnings.push(`${noMaterial}/${products.length} SP thiếu chất liệu (nguồn không có)`);
if (noColors > 0) warnings.push(`${noColors}/${products.length} SP thiếu màu (nguồn không có)`);
// Cặp trùng phải luôn được gộp — nếu chan-long-chon-02 còn riêng là lỗi.
if (seenIds.has('chan-long-chon-02')) {
  errors.push('chan-long-chon-02: chưa gộp với chan-long-chon (xem MERGED_PRODUCTS trong scrape-full.mjs)');
}

const summary = {
  file, products: products.length,
  variants: products.reduce((a, p) => a + (p.variants?.length ?? 0), 0),
  images: products.reduce((a, p) => a + (p.media?.length ?? 0), 0),
  zero_price_allowed: products.filter((p) => p.price?.amount === 0).length,
  errors: errors.length, warnings: warnings.length,
  error_list: errors, warning_list: warnings,
};

// --- Safety gate (--prev): chặn nếu catalog mất >10% hoặc có giá 0 mới ---
let gate = null;
if (prevFile) {
  try {
    const prevRaw = JSON.parse(readFileSync(resolve(ROOT, prevFile), 'utf8'));
    const prevProducts = Array.isArray(prevRaw) ? prevRaw : prevRaw.products ?? [];
    const prevCount = prevProducts.length;
    const loss = prevCount ? ((prevCount - products.length) / prevCount) * 100 : 0;
    const zeroOutside = products.filter((p) => p.price?.amount === 0 && !zeroAllowed.has(p.id));
    const negative = products.filter((p) => p.price?.amount < 0 || (p.variants ?? []).some((v) => v.price?.amount < 0));
    gate = { prev_count: prevCount, new_count: products.length, loss_percent: Number(loss.toFixed(1)), zero_price_outside_allowlist: zeroOutside.length, negative_price: negative.length };
    if (prevCount > 0 && products.length < prevCount * 0.9) {
      errors.push(`safety-gate: catalog mất ${loss.toFixed(1)}% (${prevCount} -> ${products.length}), vượt ngưỡng 10%`);
    }
    if (zeroOutside.length > 0) errors.push(`safety-gate: ${zeroOutside.length} SP giá = 0 ngoài danh sách cho phép: ${zeroOutside.map((p) => p.id).join(', ')}`);
    if (negative.length > 0) errors.push(`safety-gate: ${negative.length} SP có giá âm`);
    summary.gate = gate;
  } catch (e) {
    warnings.push(`safety-gate: không đọc được file trước (${prevFile}): ${e.message}`);
  }
}

// --- Đối chiếu manifest ảnh (--manifest) ---
// Manifest ghi theo local_path (1 file trên đĩa = 1 entry): 4 URL nguồn
// được 2 SP dùng chung nên không thể ghi theo source_url được.
let manifestCheck = null;
if (manifestFile) {
  try {
    if (!existsSync(resolve(ROOT, manifestFile))) {
      warnings.push(`manifest: không có file ${manifestFile} — ảnh chưa được tải về repo`);
    } else {
      const manifest = JSON.parse(readFileSync(resolve(ROOT, manifestFile), 'utf8'));
      const entries = manifest.images ?? {};
      let missing = 0, mismatch = 0, missingFile = 0;
      const allLocal = new Set();
      for (const p of products) {
        for (const m of p.media ?? []) {
          allLocal.add(m.src);
          const e = entries[m.src];
          if (!e) { missing++; continue; }
          if (e.source_url !== m.source_url) { mismatch++; errors.push(`${p.id}: manifest source_url của ${m.src} khác media.source_url`); }
          if (!existsSync(resolve(ROOT, m.src))) { missingFile++; errors.push(`${p.id}: file ảnh tự lưu không tồn tại: ${m.src}`); }
        }
      }
      let orphans = 0;
      for (const local of Object.keys(entries)) if (!allLocal.has(local)) orphans++;
      if (orphans > 0) warnings.push(`manifest: ${orphans} ảnh thừa không còn trong catalog (cần chạy images.mjs để dọn dẹp)`);
      manifestCheck = { entries: Object.keys(entries).length, missing, mismatch, missing_file: missingFile, orphans };
      if (missing > 0) warnings.push(`manifest: ${missing} ảnh chưa có trong manifest (chưa chạy images.mjs hoặc tải lỗi)`);
    }
    summary.manifest = manifestCheck;
  } catch (e) {
    errors.push(`manifest: lỗi đọc ${manifestFile}: ${e.message}`);
  }
}

summary.errors = errors.length;
console.log(JSON.stringify(summary, null, 2));
process.exit(errors.length ? 1 : 0);
