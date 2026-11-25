// images.mjs — Tải ảnh sản phẩm từ source_url về repo, chuyển sang WebP.
// Node.js 18+, KHÔNG dependency npm. Cần ffmpeg (libwebp) trong PATH.
//   node scripts/sync/images.mjs [--products data/products.json]
//     [--manifest data/image-manifest.json] [--limit N] [--force]
//     [--concurrency 5] [--quality 70] [--max-width 1200]
//
// NGUYÊN TẮC (theo mô hình everon.site, chỉnh cho DreamLand):
//  - Đường dẫn ảnh tự lưu đã có sẵn trong dữ liệu: mỗi media entry có
//    trường `src` (vd: assets/img/products/tp-12/cover.webp) do
//    scrape-full.mjs sinh ra. Script này chỉ tải file về đúng đường
//    dẫn đó — KHÔNG đổi schema.
//  - Chỉ tải ảnh mới/thay đổi: manifest data/image-manifest.json ghi
//    theo LOCAL_PATH (1 file trên đĩa = 1 entry: local_path ->
//    source_url + sha256). Không ghi theo source_url vì 4 URL nguồn
//    được 2 SP dùng chung (vd RUOT-CHAN-DREAMLAND-2.jpg cho cả
//    ruot-chan-ep-hoi-classic và ruot-chan-micro) — ghi theo source_url
//    sẽ đè nhau. Ảnh đã có trong manifest, source_url khớp và file còn
//    trên đĩa thì bỏ qua. --force để tải lại toàn bộ.
//  - URL nguồn dùng chung cho 2 SP: chỉ tải 1 lần trong đợt chạy
//    (cache buffer theo source_url), ghi ra cả 2 thư mục.
//  - Ảnh nguồn DreamLand rất lớn (vd 1701x2548, JPG gốc ~230 KB) —
//    chuyển WebP q80 giữ nguyên kích thước cho file LỚN HƠN cả file gốc
//    (đo thực tế 25/11/2026: TP12.1.jpg 223 KB → WebP q80 491 KB).
//    Vì vậy mặc định thu nhỏ về tối đa 1200px chiều rộng (--max-width,
//    không phóng to ảnh nhỏ hơn) và chất lượng 70 (--quality): cùng ảnh
//    đó còn 224 KB, vẫn lớn hơn khung hiển thị trên web (~700px).
//    Ước tính toàn catalog 1.246 ảnh ~150 MB (đo mẫu 20 ảnh đầu).
//    Muốn giữ nguyên kích thước gốc: --max-width 0. Muốn chất lượng
//    cao hơn: --quality 80 (ước tính ~190 MB).
//  - Chuyển đổi thất bại với 1 ảnh: giữ nguyên định dạng gốc (lưu
//    thành .jpg/.png theo đuôi URL), cập nhật lại `src` trong
//    products.json cho ảnh đó, ghi cảnh báo — KHÔNG dừng cả đợt.
//  - Tải lỗi sau 2 lần thử lại: ghi lỗi, tiếp tục ảnh khác. Chỉ fail
//    toàn bộ khi >10% ảnh lỗi (nghi nguồn chặn hoặc mạng sự cố).
//  - Chạy song song có giới hạn (mặc định 5), timeout 30s/ảnh.
//  - Không commit/push. Chỉ ghi file ảnh + manifest (+ products.json
//    khi có ảnh phải giữ định dạng gốc).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USER_AGENT =
  'dreamlandvn-site-sync-images/1.0 (+https://dreamlandvn.com; distributor: Cong ty TNHH Diep Xuan; contact via dreamlandvn.com)';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const eq = args.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
  if (eq !== undefined) return eq;
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PRODUCTS_FILE = argVal('--products', 'data/products.json');
const MANIFEST_FILE = argVal('--manifest', 'data/image-manifest.json');
const LIMIT = Number(argVal('--limit', NaN));
const FORCE = args.includes('--force');
const CONCURRENCY = Math.max(1, Number(argVal('--concurrency', 5)) || 5);
const QUALITY = Math.min(100, Math.max(1, Number(argVal('--quality', 70)) || 70));
const MAX_WIDTH = Math.max(0, Number(argVal('--max-width', 1200)) || 0);
const TIMEOUT_MS = Number(argVal('--timeout-ms', 30000)) || 30000;
const MAX_RETRIES = 2; // + lần đầu = tối đa 3 lần tải
const MAX_BYTES = 20 * 1024 * 1024; // 20MB/ảnh: chống file lạ

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-encoders']);
    if (!stdout.includes('libwebp')) throw new Error('ffmpeg khong co bo ma libwebp');
  } catch (e) {
    console.error('[images] KHONG TIM THAY ffmpeg co libwebp.');
    console.error('  Cai dat: Ubuntu/Debian: sudo apt-get install -y ffmpeg');
    console.error('  macOS: brew install ffmpeg');
    console.error('  Chi tiet loi:', e.message);
    process.exit(2);
  }
}

async function download(url, tries = MAX_RETRIES + 1) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      if (buf.length === 0) throw new Error('file rong');
      if (buf.length > MAX_BYTES) throw new Error(`file qua lon (${buf.length} bytes)`);
      return buf;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? new Error(`timeout ${TIMEOUT_MS}ms`) : e;
      console.log(`  [tai-loi] ${url} (lan ${i}/${tries}): ${lastErr.message}`);
      if (i < tries) await sleep(2000);
    }
  }
  throw lastErr;
}

async function toWebp(inputPath, outputPath, quality, maxWidth) {
  const args = ['-y', '-v', 'error', '-i', inputPath];
  if (maxWidth > 0) args.push('-vf', `scale='min(${maxWidth},iw)':-2`);
  args.push('-c:v', 'libwebp', '-q:v', String(quality), '-preset', 'photo', outputPath);
  await execFileAsync('ffmpeg', args);
  const st = statSync(outputPath);
  if (st.size === 0) throw new Error('ffmpeg tao file rong');
  const head = readFileSync(outputPath).subarray(0, 12);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('file ra khong phai WebP hop le');
  }
  return st.size;
}

async function probeSize(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath,
    ]);
    const [w, h] = stdout.trim().split(',').map(Number);
    if (Number.isInteger(w) && Number.isInteger(h)) return { width: w, height: h };
  } catch { /* bo qua: khong bat buoc */ }
  return { width: null, height: null };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  await checkFfmpeg();
  const startedAt = Date.now();
  const productsRaw = JSON.parse(readFileSync(resolve(ROOT, PRODUCTS_FILE), 'utf8'));
  const products = Array.isArray(productsRaw) ? productsRaw : productsRaw.products ?? [];
  if (!products.length) { console.error('[images] Khong co san pham nao trong', PRODUCTS_FILE); process.exit(1); }

  let manifest = { schema_version: 1, generated_at: null, summary: null, images: {} };
  const manifestPath = resolve(ROOT, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { console.log('[images] Manifest cu loi — tao moi'); }
  }
  manifest.images = manifest.images ?? {};

  // Thu thap viec can lam: moi media entry la 1 anh.
  const jobs = [];
  const seenLocal = new Set();
  for (const p of products) {
    for (const m of p.media ?? []) {
      if (!m.source_url || !/^https?:\/\//.test(m.source_url)) {
        console.log(`  [bo-qua] ${p.id}: source_url khong hop le`);
        continue;
      }
      if (!m.src || typeof m.src !== 'string') {
        console.log(`  [bo-qua] ${p.id}: media thieu truong src (duong dan anh tu luu)`);
        continue;
      }
      seenLocal.add(m.src);
      jobs.push({ sku: p.id, slug: p.slug, role: m.role, source_url: m.source_url, local_path: m.src });
    }
  }
  const limited = Number.isFinite(LIMIT) ? jobs.slice(0, LIMIT) : jobs;
  console.log(`[images] ${limited.length} anh can xu ly (${products.length} san pham, concurrency ${CONCURRENCY}, chat luong WebP ${QUALITY}, rong toi da ${MAX_WIDTH || 'goc'}px)`);

  const tmpDir = mkdtempSync(join(tmpdir(), 'dreamland-images-'));
  const stats = { total: limited.length, downloaded: 0, skipped: 0, converted: 0, fallback_original: 0, failed: 0, pruned: 0, bytes_total: 0 };
  const failures = [];
  const warnings = [];
  const srcUpdates = new Map(); // local_path cũ -> local_path mới (khi phải giữ định dạng gốc)
  const downloadCache = new Map(); // source_url -> Buffer (URL dùng chung cho 2 SP chỉ tải 1 lần)
  let done = 0;

  async function processOne(job, idx) {
    const outPath = resolve(ROOT, job.local_path);
    const entry = manifest.images[job.local_path];
    if (!FORCE && entry && entry.source_url === job.source_url && existsSync(outPath)) {
      stats.skipped++;
      return;
    }
    try {
      let buf = downloadCache.get(job.source_url);
      if (!buf) {
        buf = await download(job.source_url);
        downloadCache.set(job.source_url, buf);
      }
      const hash = sha256(buf);
      mkdirSync(dirname(outPath), { recursive: true });
      const tmpIn = join(tmpDir, `in-${idx}`);
      writeFileSync(tmpIn, buf);
      let finalPath = outPath;
      let format = 'webp';
      let bytes = 0;
      try {
        bytes = await toWebp(tmpIn, outPath, QUALITY, MAX_WIDTH);
        stats.converted++;
      } catch (convErr) {
        // Giu nguyen dinh dang goc, doi duong dan luu cho dung dinh dang.
        const ext = (extname(new URL(job.source_url).pathname) || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
        finalPath = outPath.replace(/\.webp$/i, ext);
        mkdirSync(dirname(finalPath), { recursive: true });
        writeFileSync(finalPath, buf);
        bytes = buf.length;
        format = ext.replace('.', '');
        stats.fallback_original++;
        const msg = `${job.sku} ${job.source_url}: chuyen WebP loi (${convErr.message}) — giu dinh dang goc ${finalPath}`;
        warnings.push(msg);
        console.log('  [canh-bao]', msg);
        srcUpdates.set(job.local_path, finalPath.replace(ROOT + '/', ''));
      }
      const size = await probeSize(finalPath);
      manifest.images[job.local_path] = {
        source_url: job.source_url,
        local_path: finalPath.replace(ROOT + '/', ''),
        sha256: hash,
        bytes,
        format,
        width: size.width,
        height: size.height,
        role: job.role,
        sku: job.sku,
        updated_at: new Date().toISOString(),
      };
      stats.downloaded++;
      stats.bytes_total += bytes;
    } catch (e) {
      stats.failed++;
      failures.push({ sku: job.sku, source_url: job.source_url, local_path: job.local_path, error: String(e.message ?? e) });
      console.log(`  [loi] ${job.sku} ${job.source_url}: ${e.message}`);
    } finally {
      done++;
      if (done % 25 === 0 || done === limited.length) {
        console.log(`  [tien-do] ${done}/${limited.length} (tai moi ${stats.downloaded}, bo qua ${stats.skipped}, loi ${stats.failed})`);
      }
    }
  }

  // Worker pool gioi han song song.
  let next = 0;
  async function worker() {
    while (next < limited.length) {
      const idx = next++;
      await processOne(limited[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, limited.length) }, () => worker()));

  // Don dep: xoa anh trong manifest ma catalog khong con dung.
  for (const local of Object.keys(manifest.images)) {
    if (!seenLocal.has(local)) {
      const old = manifest.images[local];
      const p = resolve(ROOT, old.local_path);
      if (p.startsWith(join(ROOT, 'assets', 'img', 'products') + '/') && existsSync(p)) {
        try { rmSync(p); } catch { /* bo qua */ }
      }
      delete manifest.images[local];
      stats.pruned++;
    }
  }

  // Cap nhat src trong products.json neu co anh phai giu dinh dang goc.
  if (srcUpdates.size > 0) {
    let changed = 0;
    for (const p of products) {
      for (const m of p.media ?? []) {
        const np = srcUpdates.get(m.src);
        if (np && m.src !== np) { m.src = np; changed++; }
      }
    }
    if (changed > 0) {
      writeFileSync(resolve(ROOT, PRODUCTS_FILE), JSON.stringify(products, null, 2) + '\n', 'utf8');
      console.log(`[images] Da cap nhat src cho ${changed} media trong ${PRODUCTS_FILE} (giu dinh dang goc)`);
    }
  }

  manifest.generated_at = new Date().toISOString();
  manifest.summary = { ...stats, duration_ms: Date.now() - startedAt, failures, warnings };
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmpManifest = manifestPath + '.tmp';
  writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(tmpManifest, manifestPath);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* bo qua */ }

  console.log('[images] HOAN THANH:', JSON.stringify({ ...stats, seconds: ((Date.now() - startedAt) / 1000).toFixed(1) }));
  if (failures.length) console.log('[images] Anh loi:', JSON.stringify(failures, null, 2));
  const failRate = stats.total ? stats.failed / stats.total : 0;
  if (failRate > 0.1) {
    console.error(`[images] THAT BAI: ${stats.failed}/${stats.total} anh loi (>${10}%) — nghi nguon chan hoac mang su co.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('[images] THAT BAI:', e.message); process.exit(1); });
