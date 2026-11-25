/* dreamlandvn.com — tầng dữ liệu + render giao diện.
   Plain JavaScript, không framework. Một điểm đọc dữ liệu duy nhất:
   toàn bộ trang đều lấy dữ liệu từ thư mục data/*.json; sau này
   chuyển sang DB chỉ cần thay hàm fetchJSON, không đổi cấu trúc site.
   Lưu ý: không có link nào trong giao diện trỏ ra ngoài site.
   Quy tắc giá: hiển thị GIÁ GỐC (compare_at_price); giá 0 hiện
   "Liên hệ", không hiện 0đ. Ảnh: ưu tiên ảnh tự lưu trong repo,
   lỗi thì fallback sang ảnh nguồn, cả 2 lỗi thì hiện ảnh placeholder. */
(function () {
  "use strict";

  var ROOT = window.__ROOT__ || "./";
  var DATA_BASE = window.__DATA_BASE__ || "data/";

  /* ---------- tiện ích ---------- */
  function vnd(n) {
    return Number(n || 0).toLocaleString("vi-VN") + "đ";
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function decodeEntities(s) {
    var t = document.createElement("textarea");
    t.innerHTML = String(s || "");
    return t.value;
  }
  /* Bỏ dấu tiếng Việt để tìm kiếm không phân biệt dấu. */
  function norm(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase();
  }
  /* Mô tả nguồn đôi khi kèm phần rác sau nội dung chính (đánh giá,
     chính sách giao hàng, form tư vấn...). Chỉ giữ phần mô tả thật. */
  var DESC_CUT_MARKERS = [
    "Đánh giá (",
    "Chính sách giao hàng",
    "Nhận tư vấn sản phẩm",
    "Thông tin sản phẩm",
    "- Chất liệu vải:",
    "Thêm vào giỏ",
    "Mua ngay",
    "Tìm cửa hàng"
  ];
  function cleanDescription(text) {
    var d = decodeEntities(text || "").replace(/\s+/g, " ").trim();
    var cut = d.length;
    DESC_CUT_MARKERS.forEach(function (m) {
      var i = d.indexOf(m);
      if (i > 0 && i < cut) cut = i;
    });
    d = d.slice(0, cut).trim();
    if (d.length > 900) d = d.slice(0, 900).replace(/\s+\S*$/, "") + "…";
    return d;
  }

  /* Ảnh placeholder nội bộ (SVG data URI, không tải ngoài): dùng khi
     sản phẩm không có ảnh và khi cả ảnh tự lưu lẫn ảnh nguồn đều lỗi. */
  var PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">' +
    '<rect width="600" height="600" fill="#eef1f4"/>' +
    '<text x="300" y="285" font-family="system-ui,sans-serif" font-size="120" font-weight="700" fill="#10233a" text-anchor="middle">D</text>' +
    '<text x="300" y="345" font-family="system-ui,sans-serif" font-size="28" fill="#5b6572" text-anchor="middle">Chưa có ảnh</text>' +
    "</svg>"
  );

  /* ---------- tầng đọc dữ liệu (điểm duy nhất) ---------- */
  var cache = null;
  function fetchJSON(rel) {
    return fetch(DATA_BASE + rel).then(function (r) {
      if (!r.ok) throw new Error("Không tải được " + rel + " (" + r.status + ")");
      return r.json();
    });
  }
  function loadData() {
    if (cache) return Promise.resolve(cache);
    return Promise.all([
      fetchJSON("products.json"),
      fetchJSON("site.json"),
      fetchJSON("categories.json")
    ]).then(function (res) {
      var cats = res[2].categories || res[2];
      cache = { products: res[0], site: res[1], categories: cats };
      return cache;
    });
  }

  /* ---------- liên kết nội bộ + Zalo ---------- */
  /* Khóa sản phẩm trên URL là id (slug) vì 72 sản phẩm không có SKU
     chuẩn; trang chi tiết chấp nhận cả id, sku và slug. */
  function productKey(p) { return p.id || p.slug || p.sku || ""; }
  function productUrl(p) {
    return ROOT + "san-pham.html?sku=" + encodeURIComponent(productKey(p));
  }
  function categoryUrl(catId) {
    return ROOT + "danh-muc.html?cat=" + encodeURIComponent(catId);
  }
  function findProduct(products, key) {
    var k = String(key || "").toLowerCase();
    if (!k) return null;
    return products.find(function (x) {
      return String(x.id || "").toLowerCase() === k ||
        String(x.slug || "").toLowerCase() === k ||
        String(x.sku || "").toLowerCase() === k;
    }) || null;
  }
  function zaloUrl(phone, message) {
    var u = "https://zalo.me/" + String(phone).replace(/\s/g, "");
    if (message) u += "?text=" + encodeURIComponent(message);
    return u;
  }
  function variantLabel(v) {
    if (!v) return "";
    var parts = [];
    if (v.set_type) parts.push(v.set_type);
    if (v.size) parts.push(v.size);
    return parts.join(" ");
  }
  function zaloMessage(p, variant) {
    var code = p.sku || p.id;
    var msg = "Chào Điệp Xuân, em muốn hỏi về sản phẩm " + p.name + " (Mã: " + code + ")";
    var vl = variantLabel(variant);
    if (vl) msg += " — " + vl;
    return msg;
  }
  function zaloButtonsHTML(site, p, variant) {
    return (site.zalo || [])
      .map(function (z) {
        return (
          '<a class="btn btn-zalo" href="' +
          esc(zaloUrl(z.phone, p ? zaloMessage(p, variant) : "")) +
          '" target="_blank" rel="noopener">Nhắn Zalo ' +
          esc(z.phone) +
          "</a>"
        );
      })
      .join("\n");
  }
  function hotlinePhone(site) {
    var loc = (site.locations || [])[0];
    if (loc && loc.phone) return loc.phone;
    var z = (site.zalo || [])[1] || (site.zalo || [])[0];
    return z ? z.phone : "";
  }

  /* ---------- ảnh: tự lưu -> nguồn -> placeholder ---------- */
  function coverMedia(p) {
    var m = (p.media || []).find(function (x) { return x.role === "cover"; }) || (p.media || [])[0];
    return m || null;
  }
  /* Đường dẫn ảnh hiển thị: ưu tiên ảnh tự lưu trong repo (m.src),
     chưa có thì dùng source_url. Không hardcode tên miền nguồn ở đây —
     source_url lấy từ dữ liệu, nên giao diện không chứa link ra ngoài. */
  function localSrc(m) { return m ? (m.src || m.source_url || "") : ""; }
  function fallbackSrc(m) {
    var s = localSrc(m);
    return m && m.source_url && m.source_url !== s ? m.source_url : "";
  }
  /* Thẻ <img>: lỗi ảnh tự lưu -> đổi sang source_url 1 lần;
     lỗi cả source_url -> hiện ảnh placeholder nội bộ (không ẩn,
     không vỡ giao diện). Sản phẩm không có media thì hiện
     placeholder ngay từ đầu. */
  function imgHTML(m, alt, extra) {
    if (!m) {
      return '<img src="' + PLACEHOLDER + '" alt="' + esc(alt) + '"' + (extra || "") + ">";
    }
    var src = localSrc(m);
    var fb = fallbackSrc(m);
    return '<img src="' + esc(src) + '"' +
      (fb ? ' data-fallback="' + esc(fb) + '"' : "") +
      ' alt="' + esc(alt) + '"' + (extra || "") + ">";
  }
  function onImgError(e) {
    var img = e && e.target ? e.target : null;
    if (!img || !img.getAttribute) return;
    var fb = img.getAttribute("data-fallback");
    if (fb && !(img.dataset && img.dataset.fbTried)) {
      if (img.dataset) img.dataset.fbTried = "1";
      img.src = fb;
      return;
    }
    /* Cả ảnh tự lưu lẫn ảnh nguồn đều lỗi (hoặc không có ảnh nguồn):
       hiện placeholder nội bộ, không đổi src nữa. */
    if (!(img.dataset && img.dataset.phTried)) {
      if (img.dataset) img.dataset.phTried = "1";
      img.removeAttribute("data-fallback");
      img.src = PLACEHOLDER;
    }
  }
  /* Gắn bắt lỗi ảnh (capture, vì sự kiện error không nổi bọt) cho mọi
     <img data-fallback> trong một khối vừa render xong. Gọi ngay sau
     mỗi lần gán innerHTML chứa ảnh — ảnh tải bất đồng bộ nên listener
     gắn kịp trước khi lỗi xảy ra. */
  function bindImageFallbacks(root) {
    if (!root || !root.querySelectorAll) return;
    var imgs = root.querySelectorAll("img[data-fallback]");
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].addEventListener("error", onImgError, true);
    }
  }

  /* ---------- dữ liệu sản phẩm ---------- */
  function isOOS(p) {
    return p.status === "out_of_stock";
  }
  function defaultVariant(p) {
    var vs = p.variants || [];
    var d = vs.find(function (v) { return v.price && v.price.amount === (p.price && p.price.amount); });
    return d || vs[0] || null;
  }
  /* GIÁ HIỂN THỊ TRÊN SITE LÀ GIÁ GỐC (compare_at_price), không phải giá
     sau khuyến mãi. Dữ liệu DreamLand hiện không có sản phẩm sale
     (compare_at_price = price) nhưng vẫn giữ logic này cho tương lai. */
  function displayPriceAmount(v, fallbackAmount) {
    var sale = v && v.price ? v.price.amount : null;
    var orig = v && v.compare_at_price ? v.compare_at_price.amount : null;
    if (orig != null && sale != null && orig > sale) return orig;
    if (sale != null) return sale;
    return fallbackAmount != null ? fallbackAmount : 0;
  }
  function displayPriceOfProduct(p) {
    var sale = p && p.price ? p.price.amount : null;
    var orig = p && p.compare_at_price ? p.compare_at_price.amount : null;
    if (orig != null && sale != null && orig > sale) return orig;
    return sale != null ? sale : 0;
  }
  /* Giá 0 (hàng trưng bày, chưa nhập giá) hiện "Liên hệ", không hiện 0đ. */
  function priceText(amount) {
    return amount > 0 ? vnd(amount) : "Liên hệ";
  }

  /* ---------- cây danh mục ---------- */
  function categoryById(categories, id) {
    return (categories || []).find(function (c) { return c.id === id; }) || null;
  }
  function childCategories(categories, parentId) {
    return (categories || []).filter(function (c) { return c.parent_id === parentId; });
  }
  function subtreeIds(categories, rootId) {
    var out = [rootId];
    var queue = [rootId];
    while (queue.length) {
      var cur = queue.shift();
      childCategories(categories, cur).forEach(function (c) {
        out.push(c.id);
        queue.push(c.id);
      });
    }
    return out;
  }
  function productsInCategory(products, categories, catId) {
    var ids = subtreeIds(categories, catId);
    return products.filter(function (p) {
      return (p.category_ids || []).some(function (c) { return ids.indexOf(c) !== -1; });
    });
  }
  /* Danh mục lá sâu nhất của sản phẩm (để làm breadcrumb + liên quan). */
  function leafCategory(p, categories) {
    var best = null;
    var bestDepth = -1;
    (p.category_ids || []).forEach(function (id) {
      var c = categoryById(categories, id);
      if (!c) return;
      var d = 0;
      var cur = c;
      while (cur && cur.parent_id) { d++; cur = categoryById(categories, cur.parent_id); }
      if (d > bestDepth) { bestDepth = d; best = c; }
    });
    return best;
  }
  function rootCategoryOf(cat, categories) {
    var cur = cat;
    while (cur && cur.parent_id) {
      var par = categoryById(categories, cur.parent_id);
      if (!par) break;
      cur = par;
    }
    return cur;
  }

  /* ---------- trục biến thể (suy ra từ biến thể thật) ---------- */
  /* Trục lấy từ attributes.variation_axes, nhưng giá trị lấy từ các
     biến thể thật (không tin mù vào danh sách trục): có biến thể có
     size không nằm trong trục, có biến thể set_type null, và trục
     "Độ Dày" của dem-bong-my-dream chỉ có 1 giá trị thật (9 cm).
     set_type lưu dạng "<Tên trục> <giá trị>", ví dụ "Độ Dày 9 cm",
     "Bộ sản phẩm Ga chun", "Mã sản phẩm T1". */
  function otherValueOf(v, axisName) {
    var st = v.set_type;
    if (!st) return null;
    var prefix = axisName + " ";
    return st.indexOf(prefix) === 0 ? st.slice(prefix.length) : st;
  }
  function variantAxes(p) {
    var axes = (p.attributes && p.attributes.variation_axes) || [];
    var otherAxis = axes.find(function (a) { return a.name !== "Kích thước"; }) || null;
    var sizes = [];
    var otherVals = [];
    (p.variants || []).forEach(function (v) {
      if (v.size && sizes.indexOf(v.size) === -1) sizes.push(v.size);
      if (otherAxis) {
        var ov = otherValueOf(v, otherAxis.name);
        if (ov && otherVals.indexOf(ov) === -1) otherVals.push(ov);
      }
    });
    return { otherAxis: otherAxis, sizes: sizes, otherVals: otherVals };
  }
  function matchVariant(variants, size, other, otherAxisName) {
    if (!variants.length) return null;
    var exact = variants.find(function (v) {
      var sizeOk = !size || v.size === size;
      var otherOk = !other || !otherAxisName || otherValueOf(v, otherAxisName) === other;
      return sizeOk && otherOk;
    });
    if (exact) return exact;
    if (size) {
      var bySize = variants.find(function (v) { return v.size === size; });
      if (bySize) return bySize;
    }
    return variants[0];
  }
  function hasVariantFor(variants, size, other, otherAxisName) {
    return variants.some(function (v) {
      var sizeOk = !size || v.size === size;
      var otherOk = !other || !otherAxisName || otherValueOf(v, otherAxisName) === other;
      return sizeOk && otherOk;
    });
  }

  /* ---------- thẻ sản phẩm ---------- */
  function cardHTML(p, site, categories) {
    var coverM = coverMedia(p);
    var oos = isOOS(p)
      ? '<span class="badge badge-oos">Hết hàng</span>'
      : "";
    var leaf = categories ? leafCategory(p, categories) : null;
    var variantCount = (p.variants || []).length;
    return (
      '<article class="card">' +
      '<a href="' + esc(productUrl(p)) + '" aria-label="' + esc(p.name) + '">' +
      imgHTML(coverM, p.name + " — " + (p.sku || p.id), ' loading="lazy" width="600" height="600"' + (isOOS(p) ? ' class="oos-img"' : "")) +
      "</a>" +
      oos +
      '<div class="card-body">' +
      '<h3><a href="' + esc(productUrl(p)) + '">' + esc(p.name) + "</a></h3>" +
      '<p class="sku">Mã: ' + esc(p.sku || p.id) + "</p>" +
      '<p class="price">' + esc(priceText(displayPriceOfProduct(p))) + "</p>" +
      "<ul class=\"attrs\">" +
      (leaf ? "<li><b>Danh mục:</b> " + esc(leaf.name) + "</li>" : "") +
      "<li><b>Biến thể:</b> " + variantCount + " lựa chọn</li>" +
      "</ul>" +
      '<div class="cta">' +
      '<a class="btn btn-zalo" href="' + esc(zaloUrl((site.zalo || [])[0] ? site.zalo[0].phone : "", zaloMessage(p, null))) + '" target="_blank" rel="noopener">Nhắn Zalo</a>' +
      '<a class="btn btn-ghost" href="' + esc(productUrl(p)) + '">Xem chi tiết</a>' +
      "</div>" +
      "</div></article>"
    );
  }

  /* Thẻ 2 showroom (địa chỉ + giờ theo Google Business Profile).
     HTML tĩnh trong trang đã có sẵn 2 thẻ giống hệt để xem được khi
     chưa tải xong dữ liệu; hàm này vẽ lại từ site.locations để dữ
     liệu và giao diện không lệch nhau. */
  function locationsHTML(site) {
    return (site.locations || []).map(function (loc) {
      var phone = String(loc.phone || "").replace(/\s/g, "");
      return '<article class="loc-card">' +
        "<h3>" + esc(loc.name) + "</h3>" +
        "<p><b>Địa chỉ:</b> " + esc(loc.address) + "</p>" +
        "<p><b>Giờ mở cửa:</b> " + esc(loc.hours) + " hằng ngày.</p>" +
        '<p><b>Điện thoại:</b> <a href="tel:' + esc(phone) + '">' + esc(loc.phone) + "</a>" +
        (loc.maps_url ? ' · <a href="' + esc(loc.maps_url) + '" target="_blank" rel="noopener">Xem bản đồ</a>' : "") + "</p>" +
        (loc.rating ? "<p><b>Đánh giá:</b> " + esc(String(loc.rating).replace(".", ",")) + "★ (" + esc(String(loc.reviews || 0)) + " đánh giá trên Google)</p>" : "") +
        "</article>";
    }).join("");
  }

  /* ---------- gắn thông tin showroom / Zalo từ site.json ---------- */
  function bindSite(site) {
    document.querySelectorAll("[data-site-address]").forEach(function (el) {
      el.textContent = site.showroom.address;
    });
    document.querySelectorAll("[data-site-hours]").forEach(function (el) {
      el.textContent = site.hours.open + "–" + site.hours.close;
    });
    document.querySelectorAll("[data-locations]").forEach(function (el) {
      el.innerHTML = locationsHTML(site);
    });
    document.querySelectorAll("[data-site-distributor]").forEach(function (el) {
      el.textContent = site.distributor;
    });
    document.querySelectorAll("[data-zalo-buttons]").forEach(function (el) {
      el.innerHTML = zaloButtonsHTML(site, null, null);
    });
    document.querySelectorAll("[data-hotline]").forEach(function (el) {
      var phone = hotlinePhone(site);
      el.setAttribute("href", "tel:" + String(phone).replace(/\s/g, ""));
      el.textContent = String(phone).replace(/(\d{4})(\d{3})(\d{3})/, "$1 $2 $3");
    });
  }

  /* ---------- trang chủ ---------- */
  function initHome(data) {
    var site = data.site;
    var grid = document.getElementById("featured-grid");
    if (grid) {
      /* Chọn 8 mẫu đầu tiên theo tên A–Z, trung lập và ổn định. */
      var featured = data.products
        .slice()
        .sort(function (a, b) { return a.name < b.name ? -1 : 1; })
        .slice(0, 8);
      grid.innerHTML = featured.map(function (p) { return cardHTML(p, site, data.categories); }).join("\n");
      bindImageFallbacks(grid);
    }
    var catGrid = document.getElementById("category-grid");
    if (catGrid) {
      var roots = data.categories.filter(function (c) { return !c.parent_id; });
      catGrid.innerHTML = roots.map(function (c) {
        var count = productsInCategory(data.products, data.categories, c.id).length;
        var kids = childCategories(data.categories, c.id).slice(0, 4).map(function (k) { return k.name; }).join(" · ");
        return (
          '<a class="cat-card" href="' + esc(categoryUrl(c.id)) + '">' +
          "<h3>" + esc(c.name) + "</h3>" +
          '<p><span class="count">' + count + ' mẫu</span>' + (kids ? " — " + esc(kids) + "…" : "") + "</p>" +
          "<p>Xem danh mục →</p></a>"
        );
      }).join("\n");
    }
  }

  /* ---------- trang danh mục ---------- */
  function initCategory(data) {
    var site = data.site;
    var products = data.products;
    var categories = data.categories;
    var params = new URLSearchParams(window.location.search);
    var catId = (params.get("cat") || "").trim();
    var qParam = (params.get("q") || "").trim();
    var cat = catId ? categoryById(categories, catId) : null;
    var isSearch = !!qParam && !cat;

    var titleEl = document.getElementById("page-title");
    var leadEl = document.getElementById("page-lead");
    var crumbEl = document.getElementById("breadcrumb-cat");
    var subWrap = document.getElementById("subcat-wrap");
    var subRow = document.getElementById("subcat-row");

    var baseList;
    var pageTitle;
    var pageLead;
    if (cat) {
      baseList = productsInCategory(products, categories, cat.id);
      pageTitle = cat.name;
      pageLead = "Có " + baseList.length + " mẫu trong danh mục này (kể cả danh mục con), giá niêm yết theo hãng. Bấm vào ảnh hoặc tên sản phẩm để xem chi tiết và bảng giá theo kích thước. Sản phẩm hết hàng vẫn hiển thị kèm nhãn “Hết hàng”.";
      var root = rootCategoryOf(cat, categories);
      var crumb = '<a href="index.html">Trang chủ</a>';
      if (root && root.id !== cat.id) crumb += ' / <a href="' + esc(categoryUrl(root.id)) + '">' + esc(root.name) + "</a>";
      crumb += " / " + esc(cat.name);
      if (crumbEl) crumbEl.innerHTML = crumb;
      /* Danh mục con (chỉ khi xem nhóm gốc hoặc danh mục có con). */
      var kids = childCategories(categories, cat.id);
      if (kids.length && subWrap && subRow) {
        subWrap.style.display = "block";
        subRow.innerHTML = kids.map(function (k) {
          var n = productsInCategory(products, categories, k.id).length;
          return '<a class="chip" href="' + esc(categoryUrl(k.id)) + '">' + esc(k.name) + " (" + n + ")</a>";
        }).join("");
      }
    } else if (isSearch) {
      baseList = products;
      pageTitle = 'Kết quả tìm kiếm: "' + qParam + '"';
      pageLead = "Tìm theo tên hoặc mã sản phẩm, không phân biệt dấu.";
      if (crumbEl) crumbEl.innerHTML = '<a href="index.html">Trang chủ</a> / Tìm kiếm';
    } else {
      baseList = products;
      pageTitle = "Tất cả sản phẩm";
      pageLead = "Đầy đủ " + products.length + " mẫu, giá niêm yết theo hãng. Bấm vào ảnh hoặc tên sản phẩm để xem chi tiết và bảng giá theo kích thước. Sản phẩm hết hàng vẫn hiển thị kèm nhãn “Hết hàng”.";
      if (crumbEl) crumbEl.innerHTML = '<a href="index.html">Trang chủ</a> / Tất cả sản phẩm';
    }
    if (titleEl) titleEl.textContent = pageTitle;
    if (leadEl) leadEl.textContent = pageLead;
    document.title = pageTitle + " | DreamLand Điệp Xuân";

    var grid = document.getElementById("product-grid");
    var countEl = document.getElementById("result-count");
    var emptyEl = document.getElementById("empty-state");
    var qInput = document.getElementById("filter-q");
    var stockSelect = document.getElementById("filter-stock");
    var sortSelect = document.getElementById("filter-sort");

    if (qInput) qInput.value = qParam;

    function applyFilters() {
      var q = norm(qInput.value.trim());
      var stock = stockSelect.value;
      var sort = sortSelect.value;
      var list = baseList.filter(function (p) {
        if (q && norm(p.name + " " + (p.sku || "") + " " + p.id).indexOf(q) === -1) return false;
        if (stock === "in" && isOOS(p)) return false;
        if (stock === "out" && !isOOS(p)) return false;
        return true;
      });
      /* Sắp xếp theo GIÁ GỐC hiển thị. Sản phẩm giá 0 ("Liên hệ")
         xếp cuối khi sắp tăng dần, xếp đầu khi sắp giảm dần thì vẫn
         giữ cuối cho khỏi lẫn với hàng có giá. */
      if (sort === "price-asc") {
        list.sort(function (a, b) {
          var pa = displayPriceOfProduct(a) || Infinity;
          var pb = displayPriceOfProduct(b) || Infinity;
          return pa - pb;
        });
      } else if (sort === "price-desc") {
        list.sort(function (a, b) {
          var pa = displayPriceOfProduct(a) || 0;
          var pb = displayPriceOfProduct(b) || 0;
          return pb - pa;
        });
      } else if (sort === "name-asc") {
        list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      }

      countEl.textContent =
        "Hiển thị " + list.length + " / " + baseList.length + " sản phẩm" +
        (list.some(isOOS) || stock !== "in"
          ? " — sản phẩm hết hàng vẫn hiển thị kèm nhãn “Hết hàng”."
          : ".");
      grid.innerHTML = list.map(function (p) { return cardHTML(p, site, categories); }).join("\n");
      bindImageFallbacks(grid);
      emptyEl.style.display = list.length ? "none" : "block";
    }
    [qInput, stockSelect, sortSelect].forEach(function (el) {
      el.addEventListener("input", applyFilters);
      el.addEventListener("change", applyFilters);
    });
    applyFilters();
  }

  /* ---------- trang chi tiết ---------- */
  function initDetail(data) {
    var site = data.site;
    var params = new URLSearchParams(window.location.search);
    var key = (params.get("sku") || "").trim();
    var box = document.getElementById("product-detail");
    var notFound = document.getElementById("not-found");
    var p = findProduct(data.products, key);
    if (!p) {
      if (box) box.style.display = "none";
      if (notFound) {
        notFound.style.display = "block";
        var q = notFound.querySelector("[data-missing-sku]");
        if (q) q.textContent = key || "(không có mã)";
      }
      return;
    }
    document.title = p.name + " (" + (p.sku || p.id) + ") | DreamLand Điệp Xuân";

    var variants = p.variants || [];
    var axes = variantAxes(p);
    var otherAxis = axes.otherAxis;
    var selected = defaultVariant(p) || variants[0];
    var state = {
      size: selected ? selected.size : null,
      other: selected && otherAxis ? otherValueOf(selected, otherAxis.name) : null
    };
    function currentVariant() {
      return matchVariant(variants, state.size, state.other, otherAxis ? otherAxis.name : null) || selected;
    }

    /* Breadcrumb: Trang chủ / nhóm gốc / danh mục lá / tên sản phẩm. */
    var leaf = leafCategory(p, data.categories);
    var root = leaf ? rootCategoryOf(leaf, data.categories) : null;
    var crumbEl = document.getElementById("breadcrumb-detail");
    if (crumbEl) {
      var crumb = '<a href="index.html">Trang chủ</a>';
      if (root) crumb += ' / <a href="' + esc(categoryUrl(root.id)) + '">' + esc(root.name) + "</a>";
      if (leaf && leaf.id !== (root && root.id)) crumb += ' / <a href="' + esc(categoryUrl(leaf.id)) + '">' + esc(leaf.name) + "</a>";
      crumb += " / " + esc(p.name);
      crumbEl.innerHTML = crumb;
    }

    var media = p.media || [];
    var coverM = coverMedia(p);
    /* Thư viện ảnh sản phẩm: nút Trước/Sau, bấm ảnh chính để xem lớn
       (lightbox tự viết, không framework), dải ảnh nhỏ trượt ngang.
       Sản phẩm không có ảnh thì hiện placeholder, không có nút
       chuyển ảnh hay xem lớn. galIndex là ảnh đang xem (0 = ảnh bìa). */
    var galIndex = 0;
    function galCount() { return media.length; }
    function galleryInner() {
      if (!galCount()) {
        return (
          '<div class="main-wrap">' +
          imgHTML(null, p.name + " — " + (p.sku || p.id), ' class="main-img"') +
          "</div>"
        );
      }
      var m = media[galIndex] || coverM;
      var nav = galCount() > 1
        ? '<button type="button" class="gal-nav gal-prev" data-gal="prev" aria-label="Ảnh trước">‹</button>' +
          '<button type="button" class="gal-nav gal-next" data-gal="next" aria-label="Ảnh sau">›</button>' +
          '<span class="gal-count">' + (galIndex + 1) + " / " + galCount() + "</span>"
        : "";
      return (
        '<div class="main-wrap">' +
        '<button type="button" class="main-btn" data-gal="zoom" aria-label="Bấm để xem ảnh lớn">' +
        imgHTML(m, p.name + " — " + (p.sku || p.id), ' id="main-img" class="main-img"') +
        "</button>" +
        nav +
        "</div>" +
        (galCount() > 1
          ? '<div class="thumbs">' +
            media.map(function (x, i) {
              return (
                '<button type="button" data-gal-idx="' + i + '" class="' + (i === galIndex ? "active" : "") + '" aria-label="Ảnh ' + (i + 1) + '">' +
                imgHTML(x, "", ' loading="lazy"') + "</button>"
              );
            }).join("") +
            "</div>"
          : "")
      );
    }
    function showImage(i) {
      var n = galCount();
      if (!n) return;
      galIndex = ((i % n) + n) % n;
      var gal = document.getElementById("gallery");
      if (gal) {
        gal.innerHTML = galleryInner();
        bindImageFallbacks(gal);
        var active = gal.querySelector(".thumbs button.active");
        if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
    /* Xem ảnh lớn: lớp phủ toàn màn hình với ảnh hiện tại, nút Trước/Sau,
       nút đóng, bấm ra nền thì đóng, Esc / phím mũi tên cũng dùng được. */
    var lbKeyOn = false;
    function lightboxHTML() {
      var m = media[galIndex] || coverM;
      return (
        '<button type="button" class="lb-close" data-lb="close" aria-label="Đóng">×</button>' +
        '<button type="button" class="lb-nav lb-prev" data-lb="prev" aria-label="Ảnh trước">‹</button>' +
        imgHTML(m, p.name + " — " + (p.sku || p.id), ' class="lb-img"') +
        '<button type="button" class="lb-nav lb-next" data-lb="next" aria-label="Ảnh sau">›</button>' +
        '<span class="lb-count">' + (galIndex + 1) + " / " + galCount() + "</span>"
      );
    }
    function refreshLightbox() {
      var lb = document.getElementById("lightbox");
      if (lb) {
        lb.innerHTML = lightboxHTML();
        bindImageFallbacks(lb);
      }
    }
    function onLbKey(e) {
      if (!e) return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") { showImage(galIndex - 1); refreshLightbox(); }
      else if (e.key === "ArrowRight") { showImage(galIndex + 1); refreshLightbox(); }
    }
    function closeLightbox() {
      var lb = document.getElementById("lightbox");
      if (lb && lb.parentNode && lb.parentNode.removeChild) lb.parentNode.removeChild(lb);
      if (lbKeyOn && document.removeEventListener) {
        document.removeEventListener("keydown", onLbKey);
        lbKeyOn = false;
      }
    }
    function openLightbox() {
      if (!galCount()) return;
      var body = document.body;
      if (!body || !body.appendChild || !document.createElement) return;
      closeLightbox();
      var lb = document.createElement("div");
      lb.className = "lightbox";
      lb.setAttribute("id", "lightbox");
      lb.setAttribute("role", "dialog");
      lb.setAttribute("aria-label", "Xem ảnh lớn");
      lb.innerHTML = lightboxHTML();
      bindImageFallbacks(lb);
      lb.addEventListener("click", function (e) {
        var t = e.target && e.target.closest ? e.target.closest("[data-lb]") : null;
        if (!t) {
          if (e.target === lb) closeLightbox();
          return;
        }
        var a = t.getAttribute("data-lb");
        if (a === "close") closeLightbox();
        else if (a === "prev") { showImage(galIndex - 1); refreshLightbox(); }
        else if (a === "next") { showImage(galIndex + 1); refreshLightbox(); }
      });
      body.appendChild(lb);
      if (document.addEventListener) {
        document.addEventListener("keydown", onLbKey);
        lbKeyOn = true;
      }
    }

    function renderInfo() {
      var v = currentVariant();
      /* Giá hiển thị là giá gốc của biến thể đang chọn; giá 0 hiện
         "Liên hệ". */
      var price = displayPriceAmount(v, displayPriceOfProduct(p));
      var oos = isOOS(p);
      var attrs = p.attributes || {};
      var sizesText = axes.sizes.length ? axes.sizes.join(" · ") : null;
      var specRows = [
        ["Mã sản phẩm", esc(p.sku || p.id)],
        ["Danh mục", leaf ? '<a href="' + esc(categoryUrl(leaf.id)) + '">' + esc(leaf.name) + "</a>" : '<span class="missing">chưa có trên nguồn</span>'],
        ["Kích thước", sizesText ? esc(sizesText) : '<span class="missing">chưa có trên nguồn</span>'],
        ["Chất liệu", attrs.material ? esc(attrs.material) : '<span class="missing">chưa có trên nguồn</span>'],
        ["Màu sắc", (attrs.colors || []).length ? esc(attrs.colors.join(" / ")) : '<span class="missing">chưa có trên nguồn</span>'],
        ["Họa tiết", attrs.pattern_type ? esc(attrs.pattern_type + (attrs.pattern ? " — " + attrs.pattern : "")) : '<span class="missing">chưa có trên nguồn</span>'],
        ["Xuất xứ", attrs.origin ? esc(attrs.origin) : '<span class="missing">chưa có trên nguồn</span>']
      ].map(function (r) {
        return "<tr><th>" + r[0] + "</th><td>" + r[1] + "</td></tr>";
      }).join("");

      /* Hàng chọn biến thể: mỗi trục có giá trị thật mới hiện.
         Nút nào không có biến thể đi kèm lựa chọn trục kia thì mờ
         (disabled) để khách không chọn phải tổ hợp không bán. */
      var pickerHTML = "";
      if (otherAxis && axes.otherVals.length > 1) {
        var otherBtns = axes.otherVals.map(function (ov) {
          var ok = hasVariantFor(variants, state.size, ov, otherAxis.name);
          return '<button type="button" class="opt' + (ov === state.other ? " active" : "") + '" data-other="' + esc(ov) + '"' + (ok ? "" : " disabled") + ">" + esc(ov) + "</button>";
        }).join("");
        pickerHTML += '<h3>Chọn ' + esc(otherAxis.name.toLowerCase()) + '</h3><div class="opt-row" id="other-picker">' + otherBtns + "</div>";
      }
      if (axes.sizes.length > 1) {
        var sizeBtns = axes.sizes.map(function (s) {
          var ok = hasVariantFor(variants, s, state.other, otherAxis ? otherAxis.name : null);
          return '<button type="button" class="opt' + (s === state.size ? " active" : "") + '" data-size="' + esc(s) + '"' + (ok ? "" : " disabled") + ">" + esc(s) + "</button>";
        }).join("");
        pickerHTML += '<h3>Chọn kích thước</h3><div class="opt-row" id="size-picker">' + sizeBtns + "</div>";
      }
      var tableHTML = "";
      if (variants.length > 1) {
        var headCells = "";
        if (otherAxis) headCells += "<th>" + esc(otherAxis.name) + "</th>";
        headCells += "<th>Kích thước</th><th>Giá gốc</th>";
        var tableRows = variants.map(function (x) {
          var cur = v && x.sku === v.sku && x.set_type === v.set_type && x.size === v.size;
          var cells = "";
          if (otherAxis) cells += "<td>" + esc(otherValueOf(x, otherAxis.name) || "—") + "</td>";
          cells += "<td>" + esc(x.size || "—") + "</td><td>" + esc(priceText(displayPriceAmount(x, null))) + "</td>";
          return '<tr class="' + (cur ? "current" : "") + '">' + cells + "</tr>";
        }).join("");
        tableHTML = "<h3>Bảng giá theo biến thể</h3>" +
          '<table class="price-table"><thead><tr>' + headCells + "</tr></thead><tbody>" + tableRows + "</tbody></table>";
      }

      var desc = cleanDescription(p.description);
      var related = relatedProducts(p, data);
      var relatedHTML = "";
      if (related.length) {
        relatedHTML = '<section class="section related" aria-labelledby="related-title">' +
          '<h2 id="related-title">Sản phẩm cùng danh mục</h2>' +
          '<div class="grid">' + related.map(function (rp) { return cardHTML(rp, site, data.categories); }).join("\n") + "</div></section>";
      }

      return (
        '<div class="detail-info">' +
        '<h1>' + esc(p.name) + "</h1>" +
        '<p class="sku">Mã: ' + esc(p.sku || p.id) + (v && v.sku && v.sku !== (p.sku || p.id) ? " · Biến thể: " + esc(v.sku) : "") + "</p>" +
        (oos
          ? '<span class="stock-note oos">Hết hàng — nhắn Zalo để hỏi khi nào có hàng</span>'
          : '<span class="stock-note in">Còn hàng</span>') +
        '<p class="detail-price">' + esc(priceText(price)) + "</p>" +
        (pickerHTML ? '<div class="variant-box">' + pickerHTML + "</div>" : "") +
        '<div class="detail-cta">' +
        zaloButtonsHTML(site, p, v) +
        '<a class="btn btn-call" data-hotline href="tel:">Gọi showroom</a>' +
        "</div>" +
        '<table class="spec">' + specRows + "</table>" +
        (desc ? '<h3>Mô tả</h3><p class="desc">' + esc(desc) + "</p>" : '<h3>Mô tả</h3><p class="desc muted">Sản phẩm chưa có mô tả trên nguồn.</p>') +
        tableHTML +
        "</div>" +
        relatedHTML
      );
    }
    function relatedProducts(p, data) {
      var leafCat = leafCategory(p, data.categories);
      if (!leafCat) return [];
      var sameLeaf = data.products.filter(function (x) {
        return x.id !== p.id && (x.category_ids || []).indexOf(leafCat.id) !== -1;
      });
      var out = sameLeaf.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; }).slice(0, 4);
      if (out.length < 4) {
        var root = rootCategoryOf(leafCat, data.categories);
        var extra = data.products.filter(function (x) {
          return x.id !== p.id && out.indexOf(x) === -1 &&
            (x.category_ids || []).indexOf(root.id) !== -1;
        }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        out = out.concat(extra.slice(0, 4 - out.length));
      }
      return out;
    }

    box.innerHTML = '<div class="gallery" id="gallery">' + galleryInner() + '</div>' + '<div id="detail-info-wrap">' + renderInfo() + "</div>";
    bindImageFallbacks(box);
    bindSite(site);

    box.addEventListener("click", function (e) {
      var t = e.target;
      /* Thư viện ảnh: nút Trước/Sau / xem lớn / chọn ảnh nhỏ. */
      var galBtn = t && t.closest ? t.closest("[data-gal]") : null;
      if (galBtn) {
        var g = galBtn.getAttribute("data-gal");
        if (g === "prev") showImage(galIndex - 1);
        else if (g === "next") showImage(galIndex + 1);
        else if (g === "zoom") openLightbox();
        return;
      }
      var thumbBtn = t && t.closest ? t.closest("[data-gal-idx]") : null;
      if (thumbBtn) {
        showImage(parseInt(thumbBtn.getAttribute("data-gal-idx"), 10) || 0);
        return;
      }
      var otherBtn = e.target.closest("[data-other]");
      var sizeBtn = e.target.closest("[data-size]");
      if (otherBtn) {
        state.other = otherBtn.getAttribute("data-other");
        if (!hasVariantFor(variants, state.size, state.other, otherAxis.name)) {
          var first = variants.find(function (x) { return otherValueOf(x, otherAxis.name) === state.other; });
          state.size = first ? first.size : state.size;
        }
      } else if (sizeBtn) {
        state.size = sizeBtn.getAttribute("data-size");
        if (otherAxis && !hasVariantFor(variants, state.size, state.other, otherAxis.name)) {
          var firstO = variants.find(function (x) { return x.size === state.size; });
          state.other = firstO ? otherValueOf(firstO, otherAxis.name) : state.other;
        }
      } else {
        return;
      }
      var wrap = document.getElementById("detail-info-wrap");
      if (wrap) wrap.innerHTML = renderInfo();
      bindSite(site);
    });
  }

  /* ---------- khởi động ---------- */
  function init() {
    var page = document.body ? document.body.getAttribute("data-page") : null;
    loadData()
      .then(function (data) {
        bindSite(data.site);
        if (page === "home") initHome(data);
        else if (page === "category") initCategory(data);
        else if (page === "detail") initDetail(data);
      })
      .catch(function (err) {
        var el = document.getElementById("load-error");
        if (el) {
          el.style.display = "block";
          el.textContent = "Không tải được dữ liệu sản phẩm. Vui lòng thử tải lại trang hoặc nhắn Zalo cho showroom.";
        }
        if (window.console) console.error(err);
      });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* API phục vụ kiểm thử (không dùng trong giao diện). */
  window.DreamLandUI = {
    cleanDescription: cleanDescription,
    norm: norm,
    vnd: vnd,
    priceText: priceText,
    defaultVariant: defaultVariant,
    displayPriceOfProduct: displayPriceOfProduct,
    displayPriceAmount: displayPriceAmount,
    locationsHTML: locationsHTML,
    onImgError: onImgError,
    localSrc: localSrc,
    fallbackSrc: fallbackSrc,
    variantAxes: variantAxes,
    matchVariant: matchVariant,
    findProduct: findProduct,
    productsInCategory: productsInCategory,
    subtreeIds: subtreeIds,
    PLACEHOLDER: PLACEHOLDER
  };
})();
