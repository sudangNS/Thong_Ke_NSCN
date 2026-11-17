# Thống kê NSCN – Nghĩa Sơn Chi Nhánh

Web nội bộ cho bộ phận thống kê: xem lệnh sản xuất (LSX) đang chạy theo cây
**LSX → dòng sản phẩm → cụm → chi tiết → công đoạn**, tìm kiếm/lọc, và in phiếu pallet
(mẫu: [docs/mau/phieu-pallet-mau.png](docs/mau/phieu-pallet-mau.png)) có **QR = part_ref + team_id** (VD `…-W004-T-TC`), 1 phiếu cho mỗi tổ chi tiết đi qua.

Nguồn dữ liệu: Google Sheet `1VVW7Zrdw-KmO2HLIh1nchKE8DRGWDtd2hCrS-e_aKUU`, gồm các tab
MO Routing, MO, MO Detail, Product, BOM Wood, Pallet Log.

## Cấu trúc

```
public/                 web tĩnh (không cần build)
  index.html, style.css
  app.js                tải dữ liệu, menu tab/phân quyền, tab Phiếu sản xuất
  production.js         suy diễn công đoạn bị bỏ qua, sản lượng theo ngày, đồng bộ chi tiết
  report.js             tab Báo cáo sản lượng
  assets/logo.png
  vendor/qrcode.js      qrcode-generator 1.4.4 (MIT), lưu cục bộ để in được cả khi CDN lỗi
functions/api/sheet/[name].js   Cloudflare Pages Function: proxy + cache Google Sheet
functions/api/me.js             email + quyền người dùng (Cloudflare Access + PERMS)
functions/_middleware.js        đổi og:image/og:url thành URL tuyệt đối (ảnh xem trước khi share link)
docs/DANH_GIA_GIOI_HAN.md       đánh giá giới hạn Google/Cloudflare & cơ chế làm mới
```

## Chức năng

Menu tab (theo quyền): **Báo cáo sản lượng** · **Phiếu sản xuất** · **Kiểm tra dữ liệu** (đang đánh giá –
[docs/Draft/DE_XUAT_KIEM_TRA_DU_LIEU.md](docs/Draft/DE_XUAT_KIEM_TRA_DU_LIEU.md)).

### Báo cáo sản lượng (Xưởng 1)

- Màn hình chính: **Tổng xưởng 1** (thành phẩm đóng gói, m³, so sánh m³ ra khỏi 5 tổ) + **5 thẻ tổ**
  Sơ chế, Tinh chế, Lắp ráp, Dầu, Bao bì (m³, số chi tiết/cụm/SP, biểu đồ theo ngày, số lượng từng công đoạn).
- Bấm thẻ → chi tiết tổ: bảng công đoạn × ngày (cột *Đã báo* / *Suy ra*), bảng theo LSX · sản phẩm → từng chi tiết.
- **Hàng tồn trên chuyền** (thẻ tổ, tổng xưởng, khung riêng trong trang tổ) tính đến hết ngày cuối kỳ:
  tồn tại tổ = đã giao tới (công đoạn trước đã báo xong) − đã giao đi; tách *chờ làm* / *đang làm dở* / *chờ ráp*,
  theo công đoạn chờ vào và theo LSX → chi tiết; tuổi tồn theo FIFO, cảnh báo khi ≥ 3 ngày. m³ tồn cộng được giữa các tổ.
- Kỳ: Ngày / Tuần / Tháng / Tuỳ chỉnh; m³ tinh (BOM `m3_finish`) hoặc m³ phôi (`m3_rough`).
  Link giữ kỳ đang xem: `#/san-luong/Sơ chế?k=week&d=2026-11-12`.
- Nguồn: tab **Pallet Log**. Công đoạn bị bỏ qua được tính bằng số của công đoạn sau; cụm/SP đã ráp thì
  chi tiết bên trong tính đã xong (xem [public/production.js](public/production.js)).
- **SL đồng bộ** trên mỗi dòng SP (tab Phiếu & báo cáo): 1 số = chi tiết ít nhất, tức
  min(số chi tiết đã xong công đoạn cuối ÷ SL chi tiết/SP); di chuột để xem chi tiết đang thiếu nhất.
- **Trung bình / ngày** (kỳ tuần, tháng, tuỳ chỉnh) = tổng sản lượng ÷ số ngày **có số liệu** trong kỳ
  (kỳ 10–20 chỉ có 5 ngày ghi nhận → chia 5).

### Phân quyền

`GET /api/me` trả email (Cloudflare Access) và quyền theo biến `PERMS` (JSON, tra email → `@tên-miền` → `*`):
`{"sudang@nghiason.com.vn":["*"],"@nghiason.com.vn":["report","phieu"]}`. Chưa đặt `PERMS` → mọi người đủ quyền.
Quyền: `report`, `phieu`, `audit`. Ẩn tab chỉ là giao diện – API ghi dữ liệu sau này phải kiểm quyền ở server.

### Phiếu sản xuất

- **Tìm kiếm** không dấu theo LSX, khách hàng, tên/mã sản phẩm, cụm, chi tiết, mã chi tiết.
  Quét QR vào ô tìm kiếm rồi Enter → mở ngay phiếu đó.
- **Lọc** theo LSX, khách hàng, sản phẩm, loại (thành phẩm/cụm/CT thuộc cụm/CT rời), nhóm công đoạn,
  công đoạn, trạng thái, chỉ LSX đang chạy.
- **Phiếu theo tổ**: 1 chi tiết/cụm/SP mang 1 phiếu cho mỗi tổ nó đi qua (Sơ chế, Tinh chế, Lắp ráp, Dầu, Đóng gói);
  trên phiếu liệt kê mọi công đoạn của chi tiết tại tổ đó (ô để thống kê đánh dấu khi xong),
  2 bảng ghi nhận đôi: Công đoạn · Ngày · Người làm · Số lượng. Dữ liệu ghi nhận vẫn theo từng công đoạn.
- **Chọn phiếu** ở mọi cấp (bấm 1 công đoạn = chọn cả phiếu tổ chứa nó): công đoạn, chi tiết, cụm, dòng SP, LSX, hoặc toàn bộ kết quả đang lọc.
  Ví dụ: lọc “Nhóm công đoạn = Sơ chế” + LSX → “Chọn tất cả” → in trọn bộ phiếu cho tổ Sơ chế.
- **Xem & in**: A5 ngang (1 phiếu/tờ) hoặc A4 dọc (2 phiếu/tờ, có đường cắt); sắp xếp theo chi tiết
  hoặc theo tổ (để chia cho từng tổ); nhập “Số pallet/phiếu” để in n bản đánh số Pallet 1/n … n/n.
- **Link chia sẻ**: `?q=…&mo=LSX-02-1626&group=Sơ chế&stage=Cắt thô&phieu=ID1,ID2&paper=a4&pallet=3`.

### Ánh xạ trường trên phiếu

| Trên phiếu | Nguồn |
|---|---|
| Công đoạn tại tổ | các bước liên tiếp cùng `stage_group` của chi tiết: `step_no`, `stage` + ô đánh dấu |
| Pallet số | in n pallet/phiếu → tự đánh 1/n … n/n; in 1 bản → để trống ghi tay |
| Lệnh sản xuất | `MO.mo_no` + `MO Detail.lsx_stt` |
| Sản phẩm | `MO Detail.product_name` |
| Cụm | tên của dòng cụm (`cum_ref`); “Chi tiết rời” / “—” cho thành phẩm |
| Tên chi tiết | `part_name` + `BOM Wood.part_code` |
| Kích thước | `BOM Wood` dày × rộng × dài (thành phẩm: `Product.size`). Dòng cụm hiện chưa có kích thước – R&D sẽ bổ sung vào BOM, web tự hiển thị khi có |
| NVL | `BOM Wood.material` (nếu trống: `Product.wood_type`) |
| SL/Pcs · SL Tổng | `qty_per_unit` · `qty_required` |
| FSC 100% / NON FSC | suy ra từ `Product.wood_type` |
| Mã lô gỗ, Mã lô dầu, bảng ghi nhận | để trống, ghi tay |
| QR + mã in dưới QR | `part_ref` + `-` + `To.team_id`, VD `LSX-02-1626-01-W004-T-TC`. Quét vào ô tìm kiếm + Enter → mở đúng phiếu đó |
| PHIẾU PALLET {TỔ …} | `To.team_name`. Tổ của phiếu: gom các bước liên tiếp cùng `MO Routing.stage_group`, tra `team_id` qua `Works List` (`work_name` = `stage`), lấy tổ chiếm đa số trong phiếu |
| Nhận từ · Giao tới, Hạn giao | công đoạn trước / sau phiếu (hoặc cụm/SP sẽ ráp vào), `MO Detail.due_date` |

## Chạy thử trên máy

Mở thư mục `public/` bằng một web server tĩnh bất kỳ (VD: extension Live Server của VS Code).
Khi không có Function, trình duyệt sẽ tự đọc thẳng Google Sheet (thanh trạng thái báo “chế độ dev”).

Chạy đầy đủ cả Function: `npx wrangler pages dev` (cần Node.js).

## Triển khai lên Cloudflare Pages

1. Đẩy repo lên GitHub → Cloudflare Dashboard → Workers & Pages → Create → Pages → kết nối repo.
2. Build command: *(để trống)* · Build output directory: `public`.
3. Biến môi trường (tuỳ chọn): `SHEET_ID`, `TTL_MO_ROUTING`…
4. Khuyến nghị: bật Cloudflare Access để chỉ email công ty truy cập được.

Hoặc dùng CLI: `npx wrangler pages deploy`.

Xem đánh giá giới hạn và cơ chế làm mới dữ liệu: [docs/DANH_GIA_GIOI_HAN.md](docs/DANH_GIA_GIOI_HAN.md).
