# Sync catalog DreamLand — scripts/sync/

Đồng bộ catalog từ **dreamland.vn** (WooCommerce) về repo này, theo cùng mô
hình với everon.site: dữ liệu JSON trong `data/`, ảnh tự lưu trong
`assets/img/products/`, GitHub Actions chạy định kỳ và mở PR để **duyệt thủ
công — KHÔNG tự merge**.

## Các script

| Script | Việc làm |
|---|---|
| `scrape-full.mjs` | Cào toàn bộ catalog từ WooCommerce Store API + WP REST API, ghi `data/products.json`, `data/categories.json`, `data/sync-state.json` |
| `images.mjs` | Tải ảnh từ `source_url` về `src` local, chuyển WebP (ffmpeg), ghi `data/image-manifest.json` |
| `validate.mjs` | Kiểm tra schema + safety gate (mất >10% catalog, giá âm, giá 0 ngoài allowlist) |
| `diff.mjs` | So sánh 2 bản products.json, tóm tắt thay đổi cho mô tả PR |

Không có script export riêng: `scrape-full.mjs` ghi thẳng `data/products.json`
dạng bare array (516 SP) và cập nhật `data/sync-state.json` trong cùng lần chạy.

## Chạy tay

```bash
# Quét tăng dần (mặc định): chỉ SP có modified đổi hoặc SP mới
node scripts/sync/scrape-full.mjs

# Quét toàn bộ (Chủ nhật / khi nghi ngờ dữ liệu lệch)
node scripts/sync/scrape-full.mjs --full

# Chạy lại từ checkpoint sau khi bị ngắt (dùng products.full.jsonl)
node scripts/sync/scrape-full.mjs --resume

# Chạy thử 5 SP đầu, ghi ra file khác (KHÔNG động vào products.json,
# KHÔNG cập nhật sync-state.json)
node scripts/sync/scrape-full.mjs --limit 5 --out /tmp/thu.json

# Tải ảnh (sau khi scrape xong)
node scripts/sync/images.mjs            # toàn bộ ảnh còn thiếu/thay đổi
node scripts/sync/images.mjs --limit 3  # thử 3 ảnh đầu

# Kiểm tra
node scripts/sync/validate.mjs data/products.json
node scripts/sync/validate.mjs data/products.json --manifest data/image-manifest.json --prev /tmp/products-prev.json
```

Yêu cầu: Node 18+, `ffmpeg` (có libwebp) cho `images.mjs`.

## Cách workflow chạy

`.github/workflows/sync.yml` — hằng ngày **03:00 giờ Việt Nam**
(cron `0 20 * * *` UTC), **Chủ nhật quét toàn bộ** (`--full`), các ngày
khác quét tăng dần. Chạy tay: Actions → Sync catalog → Run workflow,
tick `full_scan` nếu muốn quét toàn bộ. Mở PR bằng
`peter-evans/create-pull-request@v6` trên nhánh cố định `sync/catalog`,
**không auto-merge**. Timeout 240 phút, concurrency `catalog-sync`
(`cancel-in-progress: false` — lần chạy sau chờ lần trước xong).

Thứ tự các bước: scrape → images → validate (+ safety gate) → diff →
dọn file trung gian (`products.full.jsonl`, `discovery.json`,
`run-stats.json`, `sync-diff.json`) → mở PR.

## Quy tắc tăng dần theo `date_modified`

WooCommerce **Store API không trả `date_modified`** (đã kiểm tra live
25/11/2026: response không có trường ngày nào). Sitemap
`product-sitemap.xml` có `<lastmod>` nhưng **thiếu ~4 SP** nên không dùng
làm tín hiệu chính.

Tín hiệu thay đổi là trường **`modified` của từng SP**, lấy từ
**WP REST API** `GET /wp-json/wp/v2/product?_fields=id,slug,modified`
(517 SP, 6 trang, không cần API key):

- Mỗi lần chạy, scraper lấy map `slug → modified` mới, so với map đã lưu
  trong `data/sync-state.json` (`product_modified`).
- Chỉ SP có `modified` đổi **hoặc SP mới** mới được cào lại; SP còn lại
  dùng lại nguyên vẹn từ `data/products.json`.
- SP cào lỗi giữ lại `modified` cũ để lần sau cào lại.
- Chủ nhật hoặc `--full`: cào toàn bộ, bỏ qua map (lưới an toàn cho
  trường hợp sửa biến thể mà `modified` của SP cha không đổi).

Lần chạy tăng dần khi không có gì đổi chỉ mất ~1 phút, ~14 API calls
(đo 25/11/2026: 0 SP cào lại, products.json ra byte-identical).

## 3 quyết định của anh (25/11/2026) — đã áp vào dữ liệu

1. **71 SP giá 0đ: GIỮ LẠI, hiện "Liên hệ".** Giá giữ 0 trong dữ liệu.
   Danh sách cho phép nằm trong `data/zero-price-allowed.json` (71 id).
   `validate.mjs` báo lỗi nếu có SP giá 0 ngoài danh sách này, và chặn
   ở safety gate nếu lần sync sau sinh thêm SP giá 0 mới. **Quy tắc hiển
   thị "giá 0 → hiện Liên hệ" là việc của UI sau này — lúc làm giao diện
   nhớ áp, đừng để trang sản phẩm hiện "0đ".**
2. **26 SP không ảnh: GIỮ LẠI với `media: []`.** `validate.mjs` chỉ cảnh
   báo (không lỗi) khi SP không có ảnh. **UI sau này cần ảnh placeholder
   cho nhóm này** (không để khung ảnh trống/vỡ).
3. **Gộp cặp trùng `chan-long-chon` + `chan-long-chon-02` thành 1 SP.**
   Giữ id `chan-long-chon`, tên "Chăn Lông Chồn", giá 4.260.000đ,
   1 biến thể 210x230 (SKU `CHAN-LONG-CHON-210-X-230-CM`), gộp ảnh
   không trùng thành 9 ảnh (4 ảnh `CHAN-LONG-CHON-02.*` + 5 ảnh
   `CHAN-LONG-CHON-01.*`), src local đánh lại `cover.webp`, `img-2..img-9`.
   Quy tắc gộp nằm trong `scrape-full.mjs` (`MERGED_PRODUCTS` +
   `applyMerges`) và được ghi trong `data/sync-state.json`
   (`merged_products`, kèm snapshot `absorbed_media_source_urls` để lần
   sync sau gộp lại đúng ảnh mới của SP bị gộp). `validate.mjs` báo lỗi
   nếu `chan-long-chon-02` xuất hiện trở lại trong products.json.

## Ảnh

- Ảnh gốc trên dreamland.vn rất lớn (vd 1701x2548). `images.mjs` mặc
  định thu nhỏ về **tối đa 1200px chiều rộng** (`--max-width`, 0 = giữ
  nguyên) và **WebP chất lượng 70** (`--quality`): đo thực tế, ảnh
  TP12.1.jpg gốc 223 KB → WebP q80 giữ nguyên kích thước 491 KB (lớn
  hơn cả gốc), còn 1200px + q70 chỉ 224 KB, vẫn lớn hơn khung hiển thị
  trên web (~700px). Ước tính toàn catalog 1.246 ảnh ~150–210 MB.
- Manifest `data/image-manifest.json` **key theo `local_path`** (1 file
  trên đĩa = 1 entry), vì 4 URL ảnh gốc được dùng chung bởi 2 SP
  (key theo source_url sẽ ghi đè lẫn nhau). Trong 1 lần chạy, URL chung
  chỉ tải 1 lần rồi ghi ra cả 2 thư mục.
- Ảnh lỗi tải/chuyển: giữ định dạng gốc nếu chuyển WebP thất bại; nếu
  cả tải cũng thất bại thì `src` giữ trỏ về `source_url` và ảnh đó được
  tính vào lỗi — chạy fail nếu lỗi >10%.

## An toàn dữ liệu

- `validate.mjs --prev <bản cũ>` chặn PR nếu: mất >10% SP, có giá âm,
  hoặc có SP giá 0 mới ngoài allowlist.
- `scrape-full.mjs --limit` mà không kèm `--out` thì từ chối chạy
  (exit 2) để không ghi đè nhầm `products.json`; chạy `--limit` không
  cập nhật `sync-state.json`.
- `stock` của biến thể luôn `null` — Store API chỉ cho `is_in_stock`
  (boolean), không có số lượng tồn kho. Trạng thái SP lấy theo
  `is_in_stock`.
- `sku` sản phẩm có thể `null` (72 SP không có SKU trên nguồn); `id`
  sản phẩm = slug nguồn. SKU biến thể tự sinh từ slug + thuộc tính,
  viết hoa (nguồn không có SKU biến thể).
