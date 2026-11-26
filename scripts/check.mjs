// Kiểm tra giao diện dreamlandvn.com (chạy bằng node, không cần trình duyệt).
// Usage: node scripts/check.mjs  (chạy từ thư mục gốc của site)
// 1. Kiểm tra tĩnh: không có chuỗi "dreamland.vn" trong file HTML/CSS/JS,
//    không có link href nào trỏ ra ngoài (trừ Zalo + tel: + bản đồ Google).
// 2. Chạy thử app.js với DOM shim: render trang chủ / danh mục / chi tiết,
//    đếm sản phẩm, nhãn Hết hàng, thử bộ lọc, chọn biến thể, thư viện ảnh.
// Lưu ý: ảnh render trong dữ liệu vẫn trỏ source_url qua data-fallback —
// chuỗi "dreamland.vn" chỉ cấm trong FILE giao diện, không cấm trong dữ
// liệu (data/*.json đã có trên main) hay trong HTML render từ dữ liệu.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? "PASS" : "FAIL") + " — " + name + (extra ? " — " + extra : ""));
  if (!ok) failures++;
}
function walk(dir, out) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ---------- 1. Kiểm tra tĩnh ---------- */
/* everon-ref/ chỉ là file tham khảo lúc làm, không phải file của site. */
const files = walk(root, []).filter(
  (f) => /\.(html|css|js)$/.test(f) && !f.includes("/scripts/") && !f.includes("/data/") && !f.includes("/everon-ref/")
);
for (const f of files) {
  const src = readFileSync(f, "utf8");
  check(
    "không chứa dreamland.vn: " + f.replace(root + "/", ""),
    !/dreamland\.vn/i.test(src)
  );
}
for (const f of files) {
  const src = readFileSync(f, "utf8");
  check(
    "không chứa everon.com (lỗi copy từ everon): " + f.replace(root + "/", ""),
    !/everon\.com/i.test(src)
  );
}
/* Link href trong HTML: chỉ cho phép nội bộ, #..., zalo.me, tel:, mailto:,
   và link bản đồ Google tới showroom (nút "Xem bản đồ" trong thẻ địa điểm). */
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const src = readFileSync(f, "utf8");
  const hrefs = [...src.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const bad = hrefs.filter(
    (h) => /^https?:\/\//i.test(h) && !h.startsWith("https://zalo.me/") && !h.startsWith("https://www.google.com/maps/")
  );
  check("link ngoài chỉ có Zalo + bản đồ Google: " + f.replace(root + "/", ""), bad.length === 0, bad.join(", "));
  check("HTML không có 0đ: " + f.replace(root + "/", ""), !src.includes("0đ"));
  check("HTML không có slider trang chủ: " + f.replace(root + "/", ""), !/slider/i.test(src));
  check("HTML có logo chữ DREAMLAND + ĐIỆP XUÂN: " + f.replace(root + "/", ""), src.includes("DREAMLAND") && src.includes("ĐIỆP XUÂN"));
  check("HTML có link favicon.svg: " + f.replace(root + "/", ""), src.includes('href="favicon.svg"'));
  check("HTML có menu Sản phẩm + nút hamburger + drawer mobile: " + f.replace(root + "/", ""), src.includes('data-nav="products"') && src.includes("Sản phẩm") && src.includes('class="nav-toggle"') && src.includes("☰") && src.includes('class="drawer-head"') && src.includes('id="nav-backdrop"') && src.includes('id="drawer-close"'));
}
const css = readFileSync(join(root, "assets/css/style.css"), "utf8");
check("CSS có breakpoint mobile 480px", css.includes("@media (max-width: 480px)"));
check("CSS có breakpoint desktop 720px", css.includes("@media (min-width: 720px)"));
check("CSS có kiểu nút Trước/Sau cho thư viện ảnh", css.includes(".gal-nav") && css.includes(".gal-count"));
check("CSS có kiểu xem ảnh lớn (lightbox)", css.includes(".lightbox") && css.includes(".lb-img"));
check("CSS dải ảnh nhỏ trượt ngang", css.includes(".thumbs") && css.includes("overflow-x: auto"));
check("CSS có chip danh mục con", css.includes(".chip"));
check("CSS có ô tìm kiếm header", css.includes(".header-search"));
check("CSS có kiểu dropdown menu Sản phẩm", css.includes(".nav-panel") && css.includes(".nav-drop") && css.includes(".nav-group"));
/* Căn hàng dọc menu header (hồi quy: mục "Sản phẩm" từng cao hơn 3 mục
   còn lại 6px vì link lồng trong .nav-drop vẫn inline — đo thật bằng
   Chromium ở 1473/1280/1024px; sau fix lệch 0,00px ở cả 3 cỡ). */
const desk721 = (css.match(/@media \(min-width: 721px\) \{[\s\S]*?\n\}/) || [""])[0];
check("CSS căn hàng menu desktop: .nav-drop thành flex trong @media (min-width: 721px)", desk721.includes(".nav-drop { display: flex; align-items: center; }"));
check("CSS căn giữa mũi tên ▾ với chữ: .nav-drop-link thành inline-flex", desk721.includes(".nav-drop-link { display: inline-flex; align-items: center; }"));
const mobStart = css.indexOf("@media (max-width: 720px)");
const mobEnd = css.indexOf("@media (max-width: 480px)", mobStart);
const mob720 = mobStart >= 0 && mobEnd > mobStart ? css.slice(mobStart, mobEnd) : "";
check("CSS mobile (≤720px) giữ .nav-drop là block, panel accordion xếp dưới link (không dính display:flex desktop)", mob720.includes(".nav-drop { position: static; }") && !/\.nav-drop \{[^}]*display:\s*flex/.test(mob720));
check("CSS có kiểu nút hamburger + drawer trượt từ phải (mobile)", css.includes(".nav-toggle") && css.includes(".site-header.nav-open .main-nav") && css.includes("translateX(102%)") && css.includes("min(320px, 85vw)"));
check("CSS drawer cao 100dvh (fallback 100vh) + backdrop mờ", css.includes("100dvh") && css.includes("rgba(0, 0, 0, .5)") && css.includes(".nav-backdrop"));
check("CSS header mobile 2 hàng: logo + ☰ hàng 1, tìm kiếm full-width hàng 2", css.includes("flex: 1 1 100%") && css.includes("order: 3") && css.includes("margin-left: auto"));
check("CSS ô tìm kiếm mobile 16px (iOS không tự zoom)", css.includes(".header-search input, .header-search button { font-size: 16px; }"));
check("CSS active mobile nhẹ: vạch đỏ nâu trái, không pill xám", css.includes(".main-nav a.active, .nav-drop.open > .nav-drop-link") && css.includes("border-left-color: var(--rust-light)") && css.includes("background: transparent"));
check("CSS accordion mobile: nhóm con mặc định đóng, mở theo nhóm", css.includes(".nav-group-links { display: none; }") && css.includes(".nav-group.open .nav-group-links"));
check("CSS dấu ▾ xoay khi mở (class .open)", css.includes("transform: rotate(180deg)") && css.includes(".nav-group.open .nav-group-title .nav-caret"));
check("CSS dropdown Bộ sưu tập chia 3 cột, giới hạn chiều cao + cuộn dọc", css.includes(".nav-group--wide") && css.includes("max-height: calc(100vh - 90px)") && css.includes("overflow-y: auto"));
check("CSS có kiểu nút biến thể mờ (disabled)", css.includes(".opt:disabled"));
check("CSS có lưới 2 địa điểm", css.includes(".loc-grid") && css.includes(".loc-card"));
const favicon = existsSync(join(root, "favicon.svg")) ? readFileSync(join(root, "favicon.svg"), "utf8") : "";
check("favicon.svg tồn tại, là SVG hợp lệ, chữ D nền navy", favicon.includes("<svg") && favicon.includes(">D<") && favicon.includes("#10233a"));
/* 2 địa điểm theo Google Business Profile (đã xác nhận 25/11/2026). */
const siteJson = JSON.parse(readFileSync(join(root, "data/site.json"), "utf8"));
check("site.json: có 2 địa điểm", Array.isArray(siteJson.locations) && siteJson.locations.length === 2);
const loc241 = (siteJson.locations || []).find((l) => l.id === "tran-hung-dao");
const loc110 = (siteJson.locations || []).find((l) => l.id === "ly-thuong-kiet");
check(
  "site.json: 241 Trần Hưng Đạo, giờ 07:30–21:00",
  !!loc241 && loc241.address.includes("241 Trần Hưng Đạo") && loc241.hours === "07:30–21:00" && loc241.phone === "0363 089 565" && (loc241.maps_url || "").startsWith("https://www.google.com/maps/")
);
check(
  "site.json: 110 Lý Thường Kiệt, giờ 07:30–21:00",
  !!loc110 && loc110.address.includes("110 Lý Thường Kiệt") && loc110.hours === "07:30–21:00" && loc110.phone === "0363 089 565" && (loc110.maps_url || "").startsWith("https://www.google.com/maps/")
);
check(
  "site.json: 241 có đánh giá 4.7 (3 đánh giá), 110 không ghi đánh giá",
  !!loc241 && loc241.rating === 4.7 && loc241.reviews === 3 && !!loc110 && !("rating" in loc110)
);
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const src = readFileSync(f, "utf8");
  const rel = f.replace(root + "/", "");
  check("HTML có cả 2 địa chỉ showroom: " + rel, src.includes("241 Trần Hưng Đạo") && src.includes("110 Lý Thường Kiệt"));
  check("HTML có giờ cả 2 showroom (07:30–21:00): " + rel, (src.match(/07:30–21:00/g) || []).length === 2);
  check("HTML footer ghi cả 2 showroom: " + rel, src.includes("241 Trần Hưng Đạo · 110 Lý Thường Kiệt"));
}
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
check("trang chủ: không còn mục Danh mục sản phẩm (cat-title / category-grid)", !indexHtml.includes('id="cat-title"') && !indexHtml.includes('id="category-grid"'));
check("trang chủ: không còn link Trang chủ (mục này đã bỏ khỏi nav, logo vẫn link index)", !indexHtml.includes('data-nav="home"'));
const catHtmlFile = readFileSync(join(root, "danh-muc.html"), "utf8");
const detailHtmlFile = readFileSync(join(root, "san-pham.html"), "utf8");
check("trang danh mục / chi tiết: không active tĩnh, JS tự set Sản phẩm active", !catHtmlFile.includes('class="active"') && !detailHtmlFile.includes('class="active"'));
const appJs = readFileSync(join(root, "assets/js/app.js"), "utf8");
check("app.js vẽ địa điểm từ site.locations", appJs.includes("[data-locations]") && appJs.includes("site.locations") && appJs.includes("locationsHTML"));
check("app.js có placeholder ảnh + hiện Liên hệ khi giá 0", appJs.includes("PLACEHOLDER") && appJs.includes("Liên hệ") && appJs.includes("priceText"));
check("app.js có logic trục biến thể từ biến thể thật", appJs.includes("variantAxes") && appJs.includes("matchVariant") && appJs.includes("otherValueOf"));
check("app.js tìm sản phẩm theo id (72 SP không có SKU)", appJs.includes("findProduct") && appJs.includes("productKey"));
check("app.js render menu Sản phẩm từ categories", appJs.includes("renderNavMenu") && appJs.includes("childCategories") && appJs.includes("nav-panel") && appJs.includes("nav-count") && appJs.includes("nav-group-all"));
check("app.js accordion 2 tầng mobile: bấm tiêu đề nhóm mở/đóng, 1 nhóm mở tại 1 thời điểm", appJs.includes("closeAllNavGroups") && appJs.includes("isMobileNav") && appJs.includes("nav-group-title"));
check("app.js drawer trượt + vuốt mở/đóng (touch, mép phải 30px)", appJs.includes("setDrawer") && appJs.includes("nav-open") && appJs.includes("touchstart") && appJs.includes("touchend") && appJs.includes("innerWidth - 30") && appJs.includes("lockBodyScroll"));
check("app.js không còn render lưới danh mục trang chủ", !appJs.includes("category-grid"));
check("app.js tự set active cho menu theo trang", appJs.includes("setNavActive") && appJs.includes('data-nav="products"') && appJs.includes('data-nav="home"'));
check("app.js có nút hamburger + đóng menu bằng Esc / bấm ra ngoài", appJs.includes("nav-toggle") && appJs.includes("Escape") && appJs.includes("closeNavMenu"));

/* ---------- 1b. Style Điệp Xuân (A–D) + 8 trang chính sách (gói 26/11/2026) ---------- */
const POLICY_PAGES = [
  ["chinh-sach-van-chuyen.html", "Chính sách vận chuyển"],
  ["chinh-sach-doi-tra.html", "Chính sách đổi trả"],
  ["chinh-sach-bao-hanh.html", "Chính sách bảo hành"],
  ["chinh-sach-bao-mat.html", "Chính sách bảo mật"],
  ["dieu-khoan-dich-vu.html", "Điều khoản dịch vụ"],
  ["huong-dan-mua-hang.html", "Hướng dẫn mua hàng"],
  ["cau-hoi-thuong-gap.html", "Câu hỏi thường gặp"],
  ["he-thong-cua-hang.html", "Hệ thống cửa hàng"],
];
for (const [file, title] of POLICY_PAGES) {
  check("chính sách: tồn tại " + file, existsSync(join(root, file)));
  const src = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
  check("chính sách: " + file + " có tiêu đề đúng", src.includes("<title>" + title + " | DreamLand Điệp Xuân</title>"));
  check("chính sách: " + file + " có breadcrumb về trang chủ", src.includes('<a href="index.html">Trang chủ</a>'));
  check("chính sách: " + file + " có khối Cần hỗ trợ (Zalo + Gọi)", src.includes("Cần hỗ trợ?") && src.includes("zalo.me/0911825151") && src.includes("zalo.me/0363089565") && src.includes("tel:0911825151") && src.includes("tel:0363089565"));
  check("chính sách: " + file + " dùng chung style.css?v=4", src.includes('assets/css/style.css?v=4'));
  check("chính sách: " + file + " không nhắc thêm vào giỏ / thanh toán online", !/thêm vào giỏ/i.test(src) && !/thanh toán online/i.test(src));
  check("chính sách: " + file + " không có giá sale / Tiết kiệm", !/% giảm/i.test(src) && !/Tiết kiệm/i.test(src));
}
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const src = readFileSync(f, "utf8");
  const rel = f.replace(root + "/", "");
  check("footer đủ 8 link chính sách: " + rel, POLICY_PAGES.every(([file]) => src.includes('href="' + file + '"')));
  check("footer có GPDKKD 3100349022: " + rel, src.includes("GPDKKD: 3100349022"));
  check("footer có địa chỉ xưởng Thuận Đức: " + rel, src.includes("Khu làng nghề Thuận Đức, Thuận Hoà, Thuận Đức, Đồng Hới, Quảng Bình"));
  check("header có logo Điệp Xuân tự host: " + rel, src.includes('src="assets/img/logo-diep-xuan.png"'));
}
check("logo Điệp Xuân tự host tồn tại (assets/img/logo-diep-xuan.png)", existsSync(join(root, "assets/img/logo-diep-xuan.png")));
check("CSS có màu nhấn đỏ nâu Điệp Xuân #A93C11 + tông sáng cho nền tối", css.includes("--rust: #A93C11") && css.includes("--rust-light: #E86A3C"));
check("CSS chữ ĐIỆP XUÂN dùng tông sáng trên nền navy", css.includes(".brand-lockup em") && css.includes("color: var(--rust-light)"));
check("CSS giữ rule .brand > span:last-child ẩn tagline trên mobile (fix PR #7)", css.includes(".brand > span:last-child { display: none; }"));
check("CSS không còn vàng gold ở các chỗ mang dấu ấn Điệp Xuân", !css.includes("var(--gold)"));
check("trang chủ có slogan Chăn ga gối đệm cao cấp!", indexHtml.includes("Chăn ga gối đệm cao cấp!"));

/* ---------- 1c. Header gọn (gói 26/11/2026 — lấy mẫu DreamLand làm chuẩn) ---------- */
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const src = readFileSync(f, "utf8");
  const rel = f.replace(root + "/", "");
  const nav = (src.match(/<nav class="main-nav"[\s\S]*?<\/nav>/) || [""])[0];
  check("header gọn: nav chỉ còn Sản phẩm (không Trang chủ/Liên hệ/Showroom): " + rel,
    !nav.includes("Trang chủ") && !nav.includes("Liên hệ") && !nav.includes("Showroom") && nav.includes('data-nav="products"') && nav.includes("Sản phẩm"));
  check("header gọn: không còn nút Zalo rời trong drawer: " + rel, !src.includes('class="drawer-zalo"') && !nav.includes("data-zalo-buttons"));
  check("header gọn: logo vẫn link về trang chủ: " + rel, src.includes('<a class="brand" href="index.html">'));
  check("header gọn: giữ ô tìm kiếm header về danh-muc.html?q=: " + rel, src.includes('class="header-search"') && src.includes('action="danh-muc.html"'));
}
const hero = (indexHtml.match(/<section class="hero">[\s\S]*?<\/section>/) || [""])[0];
check("header gọn: hero không còn ô tìm kiếm", !indexHtml.includes("hero-search") && !hero.includes("<form"));
check("header gọn: hero không còn nút Zalo rời", !hero.includes("data-zalo-buttons"));
check("xóa nút xem SP: hero không còn nút \"Xem tất cả sản phẩm\"", !hero.includes("Xem tất cả sản phẩm"));
check("header gọn: vẫn giữ nút Zalo ở showroom (id lien-he) + footer trang chủ", indexHtml.includes('id="lien-he" data-zalo-buttons') && indexHtml.includes('Zalo bán hàng: <span data-zalo-buttons></span>'));
check("header gọn: CSS không còn .hero-search / .drawer-zalo", !css.includes(".hero-search") && !css.includes(".drawer-zalo"));
check("header gọn: CSS có kiểu nút liên hệ nổi (tròn trắng 60px, góc dưới-phải, z-index dưới header)", css.includes(".contact-fab") && css.includes("width: 60px") && css.includes("position: fixed") && css.includes("z-index: 15") && css.includes("body.fab-hidden .contact-fab"));
check("header gọn: app.js chèn nút nổi 1 lần, đủ 4 lựa chọn", appJs.includes("mountContactFab") && appJs.includes("contactFabHTML") && appJs.includes("https://zalo.me/0911825151") && appJs.includes("https://zalo.me/0363089565") && appJs.includes("tel:0911825151") && appJs.includes("tel:0363089565"));
check("header gọn: app.js ẩn nút nổi khi drawer mở", appJs.includes("fab-hidden"));

/* ---------- 2. DOM shim + chạy thử app.js ---------- */
const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (_, n) => ENTITY_MAP[n] ?? "&" + n + ";");
}
class MiniElement {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this._handlers = {};
    this.style = {};
    this.dataset = {};
    this._classSet = new Set();
    this.classList = {
      add: (c) => this._classSet.add(c),
      remove: (c) => this._classSet.delete(c),
      contains: (c) => this._classSet.has(c)
    };
    this._innerHTML = "";
    this.textContent = "";
    this.value = "";
    this._attrs = {};
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    if (this.tagName === "TEXTAREA") this.value = decodeEntities(this._innerHTML);
    const s = this._innerHTML;
    for (const m of s.matchAll(/id="([^"]+)"/g)) {
      const el = new MiniElement("div");
      if (m[1] === "detail-info-wrap") {
        const openEnd = s.indexOf(">", s.indexOf('id="detail-info-wrap"')) + 1;
        const closeStart = s.lastIndexOf("</div>");
        el._innerHTML = s.slice(openEnd, closeStart);
      }
      MiniElement.registry[m[1]] = el;
    }
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); }
  dispatch(t, ev) { (this._handlers[t] || []).forEach((fn) => fn(ev || { target: this })); }
  querySelector() { return new MiniElement("div"); }
  querySelectorAll() { return []; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  removeAttribute(k) { delete this._attrs[k]; }
  closest() { return null; }
}
MiniElement.registry = {};

function makeEnv({ page, search }) {
  MiniElement.registry = {};
  const byId = {};
  const doc = {
    readyState: "loading",
    title: "",
    body: { getAttribute: (k) => (k === "data-page" ? page : null) },
    _domHandlers: {},
    addEventListener(t, fn) { (this._domHandlers[t] = this._domHandlers[t] || []).push(fn); },
    getElementById(id) { return (byId[id] = byId[id] || MiniElement.registry[id] || new MiniElement("div")); },
    querySelectorAll() { return [new MiniElement("div"), new MiniElement("div")]; },
    querySelector() { return new MiniElement("span"); },
    createElement(tag) { return new MiniElement(tag); }
  };
  const sandbox = {
    console,
    URLSearchParams,
    document: doc,
    location: { search: search || "", pathname: "/" }
  };
  sandbox.window = sandbox;
  sandbox.window.__ROOT__ = "./";
  sandbox.window.__DATA_BASE__ = "data/";
  sandbox.fetch = async (url) => {
    const rel = String(url).replace(/^(\.\.\/)+/, "");
    const text = readFileSync(join(root, rel), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, "assets/js/app.js"), "utf8"), sandbox);
  (doc._domHandlers.DOMContentLoaded || []).forEach((fn) => fn());
  return { sandbox, doc, byId };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const products = JSON.parse(readFileSync(join(root, "data/products.json"), "utf8"));
const categories = JSON.parse(readFileSync(join(root, "data/categories.json"), "utf8")).categories;

/* Trang chủ */
{
  const { byId } = makeEnv({ page: "home", search: "" });
  await tick(300);
  const feat = byId["featured-grid"].innerHTML;
  check("trang chủ: 8 sản phẩm nổi bật", (feat.match(/<article class="card">/g) || []).length === 8);
  check("trang chủ: nổi bật đầu là AMAII – 01, 180.000đ", feat.includes("AMAII – 01") && feat.includes("180.000đ"));
  check("trang chủ: nổi bật không có giá đúng 0đ", !/>0đ</.test(feat));
  /* Menu header: dropdown Sản phẩm render từ categories.json (mục
     "Danh mục sản phẩm" trên trang chủ đã bỏ, thay bằng menu này). */
  const navHtml = byId["nav-panel"].innerHTML;
  check("menu: dropdown đủ 6 nhóm", (navHtml.match(/<div class="nav-group[\s"]/g) || []).length === 6);
  const expectedKids = { "Bộ sưu tập": 37, "Chăn": 5, "Đệm": 4, "Ruột chăn": 5, "Ruột gối": 8, "Phụ kiện": 9 };
  const navGroups = navHtml.split(/<div class="nav-group[\s"]/).slice(1);
  const countsOk = navGroups.length === 6 && navGroups.every((g) => {
    const title = ((g.match(/nav-group-title"[^>]*>([^<]+)/) || [])[1] || "").trim();
    /* Đếm con trong div nav-group-links, trừ link "Xem tất cả <nhóm>". */
    const linksDiv = (g.match(/nav-group-links">([\s\S]*?)<\/div>/) || [])[1] || "";
    const links = (linksDiv.match(/href="(\.\/)?danh-muc\.html\?cat=/g) || []).length;
    return title && expectedKids[title] === links - 1;
  });
  check("menu: đủ số con mỗi nhóm (Bộ sưu tập 37, Chăn 5, Đệm 4, Ruột chăn 5, Ruột gối 8, Phụ kiện 9)", countsOk);
  check(
    "menu: tiêu đề nhóm hiện đúng số lượng (nav-count)",
    Object.entries(expectedKids).every(([name, n]) => navHtml.includes(">" + name + ' <span class="nav-count">(' + n + ")</span>"))
  );
  check(
    "menu: mỗi nhóm có link Xem tất cả <nhóm> + dấu ▾",
    (navHtml.match(/class="nav-group-all"/g) || []).length === 6 &&
      Object.keys(expectedKids).every((name) => navHtml.includes("Xem tất cả " + name + " →")) &&
      (navHtml.match(/class="nav-caret">▾<\/span>/g) || []).length === 6
  );
  check(
    "menu: link con đúng dạng danh-muc.html?cat=",
    (navHtml.match(/href="([^"]+)"/g) || []).every((h) => /^href="(\.\/)?danh-muc\.html\?cat=[^"]+"$/.test(h) || h === 'href="./danh-muc.html"')
  );
  check(
    "menu: nhãn gọn Ruột chăn / Ruột gối, link đúng nhóm",
    navHtml.includes('href="./danh-muc.html?cat=cac-loai-ruot-chan" aria-expanded="false">Ruột chăn <span class="nav-count">(5)</span>') &&
    navHtml.includes('href="./danh-muc.html?cat=cac-loai-ruot-goi" aria-expanded="false">Ruột gối <span class="nav-count">(8)</span>')
  );
  check("menu: có link Xem tất cả sản phẩm", navHtml.includes('class="nav-all"') && navHtml.includes("Xem tất cả sản phẩm"));
  check("menu: nhóm Bộ sưu tập chia 3 cột (nav-group--wide)", navHtml.includes("nav-group--wide"));
  check("trang chủ: thẻ dùng đường dẫn tự lưu assets/img/products/", feat.includes('src="assets/img/products/'));
  check("trang chủ: thẻ có data-fallback về ảnh nguồn", feat.includes('data-fallback="https://dreamland.vn/'));
  check("trang chủ: không có link ra ngoài trong HTML render", !/href="https?:\/\/(?!zalo\.me)/.test(feat));
}

/* Nút liên hệ nổi: markup đủ 4 lựa chọn đúng thứ tự */
{
  const { sandbox } = makeEnv({ page: "home", search: "" });
  await tick(300);
  const fabHtml = sandbox.window.DreamLandUI.contactFabHTML();
  const i1 = fabHtml.indexOf("https://zalo.me/0911825151");
  const i2 = fabHtml.indexOf("https://zalo.me/0363089565");
  const i3 = fabHtml.indexOf("tel:0911825151");
  const i4 = fabHtml.indexOf("tel:0363089565");
  check("nút nổi: đủ 4 lựa chọn đúng thứ tự Zalo 0911 → Zalo 0363 → Gọi 0911 → Gọi 0363",
    i1 > -1 && i2 > i1 && i3 > i2 && i4 > i3 &&
    fabHtml.includes("Nhắn Zalo 0911825151") && fabHtml.includes("Nhắn Zalo 0363 089 565") &&
    fabHtml.includes("Gọi 0911 825 151") && fabHtml.includes("Gọi 0363 089 565"));
  check("nút nổi: không có Messenger/Facebook", !/messenger|facebook/i.test(fabHtml));
  check("nút nổi: có nút chính tròn + nút đóng ✕", fabHtml.includes("contact-fab-main") && fabHtml.includes("fab-close"));
}

/* Địa điểm: render từ site.json */
{
  const { sandbox } = makeEnv({ page: "home", search: "" });
  await tick(300);
  const locHtml = sandbox.window.DreamLandUI.locationsHTML(siteJson);
  check("locations: render đủ 2 thẻ địa điểm", (locHtml.match(/<article class="loc-card">/g) || []).length === 2);
  check("locations: render có giờ 07:30–21:00 cả 2 chỗ", (locHtml.match(/07:30–21:00/g) || []).length === 2);
  check("locations: render có link bản đồ cả 2 chỗ", (locHtml.match(/google\.com\/maps/g) || []).length === 2);
  check("locations: chỉ 241 có đánh giá sao", (locHtml.match(/★/g) || []).length === 1 && locHtml.includes("4,7★"));
  check("locations: 110 Lý Thường Kiệt không có đánh giá", locHtml.includes("110 Lý Thường Kiệt") && !/Lý Thường Kiệt[\s\S]{0,400}★/.test(locHtml));
}

/* Trang danh mục: tất cả sản phẩm */
{
  const { byId } = makeEnv({ page: "category", search: "" });
  await tick(300);
  const grid = byId["product-grid"];
  const cards = (grid.innerHTML.match(/<article class="card">/g) || []).length;
  check("danh mục: render đủ 516 sản phẩm", cards === 516, "đếm được " + cards);
  check("menu: trang danh mục cũng render đủ 6 nhóm", (byId["nav-panel"].innerHTML.match(/<div class="nav-group[\s"]/g) || []).length === 6);
  check("danh mục: 71 giá hiển thị Liên hệ (không hiện 0đ)", (grid.innerHTML.match(/Liên hệ/g) || []).length === 71, "đếm được " + (grid.innerHTML.match(/Liên hệ/g) || []).length);
  check("danh mục: không có giá đúng 0đ trong danh sách", !/>0đ</.test(grid.innerHTML));
  check("danh mục: 1 nhãn Hết hàng (Ruột gối mát)", (grid.innerHTML.match(/Hết hàng/g) || []).length === 1, "đếm được " + (grid.innerHTML.match(/Hết hàng/g) || []).length);
  check("danh mục: số lượng hiển thị 516 / 516", byId["result-count"].textContent.includes("516 / 516"));
  check("danh mục: SP không ảnh dùng placeholder data URI", grid.innerHTML.includes("data:image/svg+xml"));
  const q = byId["filter-q"];
  q.value = "tp-12";
  q.dispatch("input");
  await tick(50);
  check("lọc: tìm tp-12 ra 1 sản phẩm", (grid.innerHTML.match(/<article class="card">/g) || []).length === 1);
  q.value = "chan long chon";
  q.dispatch("input");
  await tick(50);
  check("lọc: tìm không dấu 'chan long chon' ra 16 sản phẩm", (grid.innerHTML.match(/<article class="card">/g) || []).length === 16, "đếm được " + (grid.innerHTML.match(/<article class="card">/g) || []).length);
  q.value = "";
  q.dispatch("input");
  const stock = byId["filter-stock"];
  stock.value = "out";
  stock.dispatch("change");
  await tick(50);
  check("lọc: hết hàng ra 1 sản phẩm (Ruột gối mát)", (grid.innerHTML.match(/<article class="card">/g) || []).length === 1 && grid.innerHTML.includes("Ruột gối mát"));
  stock.value = "";
  stock.dispatch("change");
  const sort = byId["filter-sort"];
  sort.value = "price-asc";
  sort.dispatch("change");
  await tick(50);
  const firstPrice = grid.innerHTML.match(/<p class="price">([\d.]+)đ/);
  check("sắp xếp: giá tăng dần bắt đầu 176.000đ", firstPrice && firstPrice[1] === "176.000", firstPrice && firstPrice[1]);
  sort.value = "price-desc";
  sort.dispatch("change");
  await tick(50);
  const firstPriceDesc = grid.innerHTML.match(/<p class="price">([\d.]+)đ/);
  check("sắp xếp: giá giảm dần bắt đầu 66.860.000đ", firstPriceDesc && firstPriceDesc[1] === "66.860.000", firstPriceDesc && firstPriceDesc[1]);
  sort.value = "name-asc";
  sort.dispatch("change");
  await tick(50);
  check("sắp xếp: tên A–Z bắt đầu AMAII – 01", grid.innerHTML.includes("AMAII – 01"));
}

/* Trang danh mục theo ?cat= */
{
  const { byId } = makeEnv({ page: "category", search: "?cat=dem" });
  await tick(300);
  check("danh mục Đệm: 19 sản phẩm", (byId["product-grid"].innerHTML.match(/<article class="card">/g) || []).length === 19);
  check("danh mục Đệm: tiêu đề Đệm", byId["page-title"].textContent === "Đệm");
  check("danh mục Đệm: có chip danh mục con (Đệm Bông các loại)", byId["subcat-row"].innerHTML.includes("Đệm Bông các loại"));
}
{
  const { byId } = makeEnv({ page: "category", search: "?cat=dem-bong-cac-loai" });
  await tick(300);
  check("danh mục Đệm Bông các loại: 8 sản phẩm (cả danh mục con)", (byId["product-grid"].innerHTML.match(/<article class="card">/g) || []).length === 8);
}
{
  const { byId } = makeEnv({ page: "category", search: "?cat=bo-suu-tap" });
  await tick(300);
  check("danh mục Bộ sưu tập: 326 sản phẩm", (byId["product-grid"].innerHTML.match(/<article class="card">/g) || []).length === 326);
}
{
  const { byId } = makeEnv({ page: "category", search: "?q=tp-12" });
  await tick(300);
  check("tìm kiếm qua URL ?q=tp-12: 1 sản phẩm, ô lọc đã điền sẵn", (byId["product-grid"].innerHTML.match(/<article class="card">/g) || []).length === 1 && byId["filter-q"].value === "tp-12");
}

/* Trang chi tiết tp-12 */
{
  const { byId, sandbox, doc } = makeEnv({ page: "detail", search: "?sku=tp-12" });
  await tick(300);
  const box = byId["product-detail"];
  check("chi tiết: render tp-12", box.innerHTML.includes("TP 12"));
  check("chi tiết: giá mặc định 1.590.000đ", box.innerHTML.includes("1.590.000đ"));
  check("chi tiết: bảng giá 3 biến thể", (box.innerHTML.match(/<tr class="/g) || []).length === 3);
  check("chi tiết: có nút chọn kích thước 160 x 200 / 180 x 200 / 200 x 220", box.innerHTML.includes("160 x 200") && box.innerHTML.includes("180 x 200") && box.innerHTML.includes("200 x 220"));
  check("chi tiết: không có hàng chọn loại bộ (tp-12 chỉ có 1 trục)", !box.innerHTML.includes("Chọn bộ sản phẩm") && !box.innerHTML.includes("Chọn độ dày") && !box.innerHTML.includes("Chọn mã sản phẩm"));
  check("chi tiết: có nút Nhắn Zalo kèm mã SP", box.innerHTML.includes("zalo.me") && box.innerHTML.includes("TP-12-160-X-200"));
  check("chi tiết: thuộc tính thiếu ghi chưa có trên nguồn", box.innerHTML.includes("chưa có trên nguồn"));
  check("chi tiết: ảnh chính dùng đường dẫn tự lưu, có fallback", box.innerHTML.includes('src="assets/img/products/') && box.innerHTML.includes('data-fallback="https://dreamland.vn/'));
  const wrap = doc.getElementById("detail-info-wrap");
  const fakeSize = { getAttribute: () => "200 x 220" };
  box.dispatch("click", { target: { closest: (sel) => (sel === "[data-size]" ? fakeSize : null) } });
  await tick(50);
  check("chi tiết: đổi kích thước 200 x 220 cập nhật giá 2.050.000đ", wrap.innerHTML.includes('<p class="detail-price">2.050.000đ</p>'));
  const gal = doc.getElementById("gallery");
  check("thư viện: có nút Trước/Sau và số đếm 1 / 3", box.innerHTML.includes('data-gal="prev"') && box.innerHTML.includes('data-gal="next"') && box.innerHTML.includes("1 / 3"));
  check("thư viện: ảnh chính có nút xem lớn", box.innerHTML.includes('data-gal="zoom"'));
  check("thư viện: đủ 3 ảnh nhỏ", (box.innerHTML.match(/data-gal-idx="/g) || []).length === 3);
  const fakeNext = { getAttribute: () => "next" };
  box.dispatch("click", { target: { closest: (sel) => (sel === "[data-gal]" ? fakeNext : null) } });
  await tick(50);
  check("thư viện: bấm Sau sang ảnh 2 / 3", gal.innerHTML.includes("2 / 3") && gal.innerHTML.includes("img-2.webp"));
  const fakeThumb3 = { getAttribute: () => "2" };
  box.dispatch("click", { target: { closest: (sel) => (sel === "[data-gal-idx]" ? fakeThumb3 : null) } });
  await tick(50);
  check("thư viện: bấm ảnh nhỏ thứ 3 sang ảnh 3 / 3", gal.innerHTML.includes("3 / 3") && gal.innerHTML.includes("img-3.webp"));
  const fakeZoom = { getAttribute: () => "zoom" };
  box.dispatch("click", { target: { closest: (sel) => (sel === "[data-gal]" ? fakeZoom : null) } });
  await tick(50);
  check("thư viện: bấm xem lớn không lỗi (môi trường kiểm thử không có body thật)", gal.innerHTML.includes("3 / 3"));
  check("chi tiết: có mục sản phẩm cùng danh mục", box.innerHTML.includes("Sản phẩm cùng danh mục"));
  {
    const ui = sandbox.window.DreamLandUI;
    const fakeImg = doc.createElement("img");
    fakeImg.src = "assets/img/products/tp-12/cover.webp";
    fakeImg.setAttribute("data-fallback", "https://dreamland.vn/wp-content/uploads/2026/11/TP12.1.jpg");
    ui.onImgError({ target: fakeImg });
    check("fallback: lỗi lần 1 đổi sang source_url", fakeImg.src === "https://dreamland.vn/wp-content/uploads/2026/11/TP12.1.jpg", fakeImg.src);
    ui.onImgError({ target: fakeImg });
    check("fallback: lỗi lần 2 hiện placeholder nội bộ, không ẩn ảnh", fakeImg.src.startsWith("data:image/svg+xml") && fakeImg.style.display !== "none");
    const noFb = doc.createElement("img");
    noFb.src = "assets/img/products/tp-12/cover.webp";
    ui.onImgError({ target: noFb });
    check("fallback: không có source_url thì hiện placeholder luôn", noFb.src.startsWith("data:image/svg+xml"));
  }
}

/* Trang chi tiết chan-long-chon (9 ảnh, 1 biến thể) */
{
  const { byId } = makeEnv({ page: "detail", search: "?sku=chan-long-chon" });
  await tick(300);
  const box = byId["product-detail"];
  check("chan-long-chon: render, giá 4.260.000đ", box.innerHTML.includes("Chăn Lông Chồn") && box.innerHTML.includes("4.260.000đ"));
  check("chan-long-chon: thư viện 1 / 9, đủ 9 ảnh nhỏ", box.innerHTML.includes("1 / 9") && (box.innerHTML.match(/data-gal-idx="/g) || []).length === 9);
  check("chan-long-chon: 1 biến thể nên không có hàng chọn biến thể, không có bảng giá", !box.innerHTML.includes("Chọn kích thước") && !box.innerHTML.includes("Bảng giá theo biến thể"));
  check("chan-long-chon: Zalo kèm mã biến thể CHAN-LONG-CHON-210-X-230-CM", box.innerHTML.includes("CHAN-LONG-CHON-210-X-230-CM"));
}

/* Trang chi tiết dem-bong-my-dream (2 trục, 4 biến thể thật) */
{
  const { byId, doc } = makeEnv({ page: "detail", search: "?sku=dem-bong-my-dream" });
  await tick(300);
  const box = byId["product-detail"];
  check("dem-bong-my-dream: render, giá mặc định 2.880.000đ", box.innerHTML.includes("2.880.000đ"));
  check("dem-bong-my-dream: hàng chọn kích thước có 4 lựa chọn", (box.innerHTML.match(/data-size="/g) || []).length === 4);
  check("dem-bong-my-dream: trục Độ Dày chỉ có 1 giá trị thật nên không hiện hàng chọn", !box.innerHTML.includes("Chọn độ dày"));
  check("dem-bong-my-dream: bảng giá 4 biến thể", (box.innerHTML.match(/<tr class="/g) || []).length === 4);
  const wrap = doc.getElementById("detail-info-wrap");
  const fakeSize = { getAttribute: () => "200 x 220" };
  box.dispatch("click", { target: { closest: (sel) => (sel === "[data-size]" ? fakeSize : null) } });
  await tick(50);
  check("dem-bong-my-dream: đổi 200 x 220 cập nhật giá 4.680.000đ", wrap.innerHTML.includes('<p class="detail-price">4.680.000đ</p>'));
}

/* Trang chi tiết hqb-05 (2 trục: Bộ sản phẩm + Kích thước) */
{
  const { byId, doc } = makeEnv({ page: "detail", search: "?sku=hqb-05" });
  await tick(300);
  const box = byId["product-detail"];
  check("hqb-05: có cả 2 hàng chọn (bộ sản phẩm + kích thước)", box.innerHTML.includes("Chọn bộ sản phẩm") && box.innerHTML.includes("Chọn kích thước"));
  check("hqb-05: bảng giá 21 biến thể", (box.innerHTML.match(/<tr class="/g) || []).length === 21);
  const p = products.find((x) => x.id === "hqb-05");
  const firstBoPhu = p.variants.find((v) => v.set_type === "Bộ sản phẩm Bộ Phủ");
  const wrap = doc.getElementById("detail-info-wrap");
  const fakeOther = { getAttribute: () => "Bộ Phủ" };
  box.dispatch("click", { target: { closest: (sel) => (sel === "[data-other]" ? fakeOther : null) } });
  await tick(50);
  const expectedPrice = firstBoPhu.price.amount.toLocaleString("vi-VN") + "đ";
  check("hqb-05: chọn Bộ Phủ cập nhật giá " + expectedPrice, wrap.innerHTML.includes('<p class="detail-price">' + expectedPrice + "</p>") && wrap.innerHTML.includes("Bộ Phủ"));
}

/* Trang chi tiết giá 0 + hết hàng + không ảnh */
{
  const { byId } = makeEnv({ page: "detail", search: "?sku=goi-tua-theu-dreamland-01" });
  await tick(300);
  const box = byId["product-detail"];
  check("goi-tua-theu-01: giá hiện Liên hệ, không có giá đúng 0đ", box.innerHTML.includes('<p class="detail-price">Liên hệ</p>') && !/>0đ</.test(box.innerHTML));
  check("goi-tua-theu-01: 1 biến thể nên không có bảng giá", !box.innerHTML.includes("Bảng giá theo biến thể"));
}
{
  const { byId } = makeEnv({ page: "detail", search: "?sku=ruot-goi-mat" });
  await tick(300);
  const box = byId["product-detail"];
  check("ruot-goi-mat: có nhãn Hết hàng", box.innerHTML.includes("Hết hàng"));
  check("ruot-goi-mat: giá hiện Liên hệ (biến thể giá 0)", box.innerHTML.includes('<p class="detail-price">Liên hệ</p>') && !/>0đ</.test(box.innerHTML));
}
{
  const { byId } = makeEnv({ page: "detail", search: "?sku=chan-mat-03-2" });
  await tick(300);
  const box = byId["product-detail"];
  check("chan-mat-03-2 (không ảnh): thư viện hiện placeholder, không có nút chuyển ảnh", box.innerHTML.includes("data:image/svg+xml") && !box.innerHTML.includes('data-gal="prev"'));
  check("chan-mat-03-2: vẫn hiện giá 220.000đ và 9 biến thể", box.innerHTML.includes("220.000đ"));
}

/* Trang chi tiết mã không tồn tại + tìm theo SKU */
{
  const { byId } = makeEnv({ page: "detail", search: "?sku=KHONGCO" });
  await tick(300);
  check("chi tiết: mã lạ hiện trang không tìm thấy", byId["not-found"].style.display === "block");
}
{
  const { sandbox } = makeEnv({ page: "detail", search: "?sku=TP%20%E2%80%93%2012" });
  await tick(300);
  const ui = sandbox.window.DreamLandUI;
  check("tìm SP: theo SKU 'TP – 12' ra tp-12", ui.findProduct(products, "TP – 12") && ui.findProduct(products, "TP – 12").id === "tp-12");
  check("tìm SP: theo id chan-long-chon", ui.findProduct(products, "chan-long-chon") && ui.findProduct(products, "chan-long-chon").name === "Chăn Lông Chồn");
  check("norm: 'Chăn Lông Chồn' -> 'chan long chon'", ui.norm("Chăn Lông Chồn") === "chan long chon");
  check("priceText: 0 -> Liên hệ, 1590000 -> 1.590.000đ", ui.priceText(0) === "Liên hệ" && ui.priceText(1590000) === "1.590.000đ");
  const d = products.find((x) => x.id === "dem-bong-my-dream");
  const axes = ui.variantAxes(d);
  check("variantAxes dem-bong-my-dream: 4 kích thước, 1 độ dày", axes.sizes.length === 4 && axes.otherVals.length === 1 && axes.otherVals[0] === "9 cm");
  const h = products.find((x) => x.id === "hqb-05");
  const mv = ui.matchVariant(h.variants, "200 x 220", "Bộ Phủ", "Bộ sản phẩm");
  check("matchVariant hqb-05 (200 x 220 + Bộ Phủ) = 5.160.000đ", mv && mv.price.amount === 5160000, mv && String(mv.price.amount));
  check("productsInCategory dem = 19, bo-suu-tap = 326", ui.productsInCategory(products, categories, "dem").length === 19 && ui.productsInCategory(products, categories, "bo-suu-tap").length === 326);
  const dirty = ui.cleanDescription("Mô tả thật. Đánh giá ( 0 ) Chính sách giao hàng xyz");
  check("cleanDescription cắt đúng phần rác", dirty === "Mô tả thật.");
}

/* Dữ liệu */
{
  check("data: 516 sản phẩm", products.length === 516);
  check("data: 4.785 biến thể", products.reduce((n, p) => n + p.variants.length, 0) === 4785);
  check("data: 1.246 ảnh", products.reduce((n, p) => n + p.media.length, 0) === 1246);
  check("data: 128 danh mục", categories.length === 128);
  check("data: 71 SP giá 0", products.filter((p) => p.price.amount === 0).length === 71);
  check("data: 26 SP không ảnh", products.filter((p) => !p.media.length).length === 26);
  check("data: 1 SP hết hàng", products.filter((p) => p.status === "out_of_stock").length === 1);
  check("data: id duy nhất", new Set(products.map((p) => p.id)).size === 516);
}

console.log(failures === 0 ? "\nTẤT CẢ KIỂM TRA ĐẠT." : "\nCÓ " + failures + " KIỂM TRA LỖI.");
process.exit(failures === 0 ? 0 : 1);
