# Đánh giá giới hạn Google Sheets & Cloudflare – cơ chế làm mới dữ liệu

*Đo thực tế ngày 13/11/2026 trên file CSDL `1VVW7Zrdw-…` (13 tab).*

## 1. Hiện trạng dữ liệu

| Tab | Số dòng | CSV thô | Ghi chú |
|---|---:|---:|---|
| MO Routing | 5.159 | 1,61 MB | ~98 KB khi nén gzip; Google trả về sau 1,8–2,5 giây |
| MO / MO Detail / Product / BOM Wood | 6 / 38 / 37 / 487 | ~85 KB tổng | ít thay đổi |

- Trung bình **~860 dòng routing / LSX**. Mỗi lần đọc là đọc **toàn bộ tab** (endpoint export không hỗ trợ đọc gia tăng).
- Ước tính khi tăng trưởng:

| LSX đang chạy | Dòng MO Routing | CSV thô | Qua mạng (gzip) | Trình duyệt parse |
|---:|---:|---:|---:|---:|
| 6 (hiện tại) | 5,2 nghìn | 1,6 MB | ~0,1 MB | < 0,1 s |
| 20 | ~17 nghìn | ~5 MB | ~0,3 MB | ~0,2 s |
| 50 | ~43 nghìn | ~13 MB | ~0,8 MB | ~0,5 s |

## 2. Giới hạn Google Sheets

| Hạng mục | Giới hạn | Mức độ ảnh hưởng |
|---|---|---|
| Dung lượng file | 10 triệu ô / file (cộng dồn mọi tab) | MO Routing 29 cột → ~150 nghìn ô hiện nay. Thoải mái, nhưng nên **lưu trữ (archive) LSX đã xong** sang file khác mỗi quý. |
| Endpoint `export?format=csv` (đang dùng) | Không công bố quota; gọi dồn dập sẽ bị **HTTP 429**. Mỗi lần gọi Google phải dựng lại cả tab (1–3 s, lâu hơn nếu có nhiều công thức). | Không được để mỗi người dùng gọi thẳng Google → bắt buộc có cache trung gian. |
| Yêu cầu quyền | Sheet phải ở chế độ “Bất kỳ ai có đường liên kết đều xem được”. | **Rủi ro bảo mật**: ai có link đều đọc được dữ liệu sản xuất. |
| Sheets API v4 (phương án nâng cấp) | 300 request đọc/phút/project, 60/phút/người dùng; không giới hạn theo ngày; nên giữ mỗi response ≤ ~2 MB. | Cho phép sheet ở chế độ riêng tư (service account), đọc 5 tab trong 1 lần `batchGet`. |
| Apps Script Web App | 20.000 UrlFetch/ngày, 6 phút/lần chạy, ~30 lượt chạy đồng thời | Không chọn làm đường đọc chính – chậm và dễ chạm trần khi nhiều người dùng. |

## 3. Giới hạn Cloudflare (Pages + Functions, gói Free)

| Hạng mục | Giới hạn gói Free | Hệ thống này dùng |
|---|---|---|
| File tĩnh (HTML/JS/logo) | Không giới hạn request | — |
| Request vào Functions (`/api/sheet/*`) | 100.000 / ngày | 20 người × 9 giờ × 12 lần/giờ × 5 tab ≈ **11.000/ngày (~11%)** |
| CPU mỗi request | 10 ms | Function **không parse CSV**, chỉ chuyển nguyên byte → ~1–3 ms. Việc parse làm ở trình duyệt. |
| Subrequest mỗi request | 50 | 1 (chỉ khi cache hết hạn) |
| Cache API | Miễn phí, không quota; cache theo từng data center | Mặc định. Người dùng ở xưởng đi qua cùng 1 data center nên dùng chung cache. |
| Workers KV (tuỳ chọn) | 100.000 lần đọc, **1.000 lần ghi**/ngày; tối đa 25 MB/giá trị | Với TTL mặc định: tối đa ~430 lần ghi/ngày. Bấm “Làm mới” nhiều có thể vượt 1.000 → chỉ bật KV khi lên gói Paid ($5/tháng). |

## 4. Cơ chế làm mới đang áp dụng

```
Trình duyệt ──(5 phút/lần, chỉ khi tab đang mở)──► /api/sheet/:tab ──(chỉ khi cache hết hạn)──► Google Sheets
```

1. **Cache phía server theo từng tab, TTL theo mức thay đổi**: MO Routing 5 phút; MO, MO Detail 30 phút; Product, BOM Wood 60 phút.
2. **Stale-while-revalidate**: khi cache quá hạn thì vẫn trả ngay bản cũ, đồng thời làm mới ngầm → người dùng không phải chờ 2 giây của Google.
3. **Gộp request**: nhiều người hỏi cùng lúc chỉ tạo **1** lần gọi Google.
4. **Nút “Làm mới”**: bỏ qua cache nhưng giới hạn tối đa **1 lần / 30 giây / tab**, tránh bị Google trả 429.
5. **Lỗi Google** (429, mất mạng, sheet bị khoá quyền): vẫn trả bản cũ, kèm cảnh báo ⚠ trên thanh trạng thái.
6. **Phía trình duyệt**: tự làm mới 5 phút/lần, chỉ khi tab đang hiển thị và **không** đang xem trước/in phiếu. Các phiếu đã chọn được giữ nguyên sau khi làm mới.
7. Thanh trạng thái luôn hiển thị **giờ của dữ liệu Sheet** (ví dụ “10:49 – 3 phút trước”).

→ Số lần gọi Google **không phụ thuộc số người dùng**: tối đa ~290 lần/ngày cho MO Routing, ~430 lần/ngày cho cả 5 tab.

## 5. Khuyến nghị theo lộ trình

1. **Ngay khi đưa vào dùng**: bật **Cloudflare Access** (Zero Trust, miễn phí ≤ 50 người) cho tên miền web, chỉ cho phép email `@nghiason.com.vn`.
2. **Bảo mật dữ liệu**: chuyển sheet về chế độ riêng tư và cho Function đọc qua **Sheets API bằng service account** (`values:batchGet` 5 tab trong 1 request, chỉ lấy các cột cần). Khi đó có thể bỏ quyền chia sẻ công khai.
3. **Khi MO Routing > ~30 nghìn dòng**: chuyển LSX đã xong sang file lưu trữ; hoặc thêm Cron Trigger (Cloudflare) tạo sẵn bản JSON đã rút gọn mỗi 5 phút trong giờ làm việc.
4. **Khi bắt đầu ghi nhận sản lượng (WIP Log)** và cần cập nhật gần như tức thời: dùng Apps Script `onChange` ghi một “số phiên bản” để trình duyệt chỉ hỏi số này (rất nhẹ), và chỉ tải lại toàn bộ khi số phiên bản thay đổi.
