// scripts/sync/diff.mjs — So sánh 2 bản data/products.json (trước/sau sync)
// để tóm tắt thay đổi đưa vào mô tả PR.
//
//   node scripts/sync/diff.mjs <prev.json> <new.json> [out.json]
//   (không có out.json thì in JSON ra stdout)
//
// So sánh theo id sản phẩm:
//   - added / removed: SP mới thêm / bị gỡ khỏi nguồn.
//   - price_changes: giá mặc định (price.amount) đổi.
//   - status_changes: trạng thái đổi (in_stock/out_of_stock).
//   - variant_changes: số biến thể đổi.
//   - media_changes: số ảnh đổi (thêm/bớt source_url).
//   - zero_price_new: SP mới có giá 0 (không nằm trong allowlist thì
//     validate.mjs --prev đã chặn trước bước này; liệt kê để PR ghi rõ).
import { readFileSync, writeFileSync } from 'node:fs';

const [prevPath, newPath, outPath] = process.argv.slice(2);
if (!prevPath || !newPath) {
  console.error('Dùng: node scripts/sync/diff.mjs <prev.json> <new.json> [out.json]');
  process.exit(2);
}

const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
const next = JSON.parse(readFileSync(newPath, 'utf8'));
const prevById = new Map(prev.map((p) => [p.id, p]));
const nextById = new Map(next.map((p) => [p.id, p]));

const added = next.filter((p) => !prevById.has(p.id)).map((p) => p.id);
const removed = prev.filter((p) => !nextById.has(p.id)).map((p) => p.id);
const price_changes = [];
const status_changes = [];
const variant_changes = [];
const media_changes = [];
for (const p of next) {
  const o = prevById.get(p.id);
  if (!o) continue;
  if ((o.price?.amount ?? null) !== (p.price?.amount ?? null)) {
    price_changes.push({ id: p.id, name: p.name, old_price: o.price?.amount ?? null, new_price: p.price?.amount ?? null });
  }
  if (o.status !== p.status) {
    status_changes.push({ id: p.id, name: p.name, old_status: o.status, new_status: p.status });
  }
  if ((o.variants?.length ?? 0) !== (p.variants?.length ?? 0)) {
    variant_changes.push({ id: p.id, name: p.name, old_variants: o.variants?.length ?? 0, new_variants: p.variants?.length ?? 0 });
  }
  const oMedia = new Set((o.media ?? []).map((m) => m.source_url));
  const nMedia = new Set((p.media ?? []).map((m) => m.source_url));
  const addedImages = [...nMedia].filter((u) => !oMedia.has(u)).length;
  const removedImages = [...oMedia].filter((u) => !nMedia.has(u)).length;
  if (addedImages || removedImages) {
    media_changes.push({ id: p.id, name: p.name, added_images: addedImages, removed_images: removedImages });
  }
}
const zero_price_new = next
  .filter((p) => p.price?.amount === 0 && prevById.get(p.id)?.price?.amount !== 0)
  .map((p) => p.id);

const diff = {
  old_count: prev.length,
  new_count: next.length,
  old_variants: prev.reduce((n, p) => n + (p.variants?.length ?? 0), 0),
  new_variants: next.reduce((n, p) => n + (p.variants?.length ?? 0), 0),
  old_images: prev.reduce((n, p) => n + (p.media?.length ?? 0), 0),
  new_images: next.reduce((n, p) => n + (p.media?.length ?? 0), 0),
  added, added_count: added.length,
  removed, removed_count: removed.length,
  price_changes,
  status_changes,
  variant_changes,
  media_changes,
  zero_price_new,
};

if (outPath) writeFileSync(outPath, JSON.stringify(diff, null, 2) + '\n');
else console.log(JSON.stringify(diff, null, 2));
