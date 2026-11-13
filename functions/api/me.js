/**
 * GET /api/me → { email, perms: [...] }
 *
 * Email lấy từ Cloudflare Access (header Cf-Access-Authenticated-User-Email).
 * Quyền cấu hình bằng biến môi trường PERMS (JSON), tra theo thứ tự: email → @tên-miền → "*".
 *   {
 *     "sudang@nghiason.com.vn": ["*"],
 *     "thongke@nghiason.com.vn": ["report", "phieu", "audit"],
 *     "@nghiason.com.vn": ["report", "phieu"],
 *     "*": []
 *   }
 * Quyền hiện có: report (Báo cáo sản lượng), phieu (Phiếu sản xuất), audit (Kiểm tra dữ liệu), "*" = tất cả.
 * Chưa đặt PERMS → mọi người đủ quyền (giữ cách chạy như trước khi có phân quyền).
 *
 * Lưu ý: ẩn tab ở trình duyệt chỉ là giao diện. Mọi API ghi/sửa dữ liệu sau này phải gọi permsOf() để kiểm lại.
 */
export function permsOf(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  if (!env.PERMS) return { email, perms: ['*'] };
  let map;
  try { map = JSON.parse(env.PERMS); } catch { return { email, perms: [], error: 'PERMS không phải JSON hợp lệ' }; }
  const domain = email.includes('@') ? email.slice(email.indexOf('@')) : '';
  const perms = (email && map[email]) || (domain && map[domain]) || map['*'] || [];
  return { email, perms };
}

export async function onRequestGet({ request, env }) {
  return new Response(JSON.stringify(permsOf(request, env)), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
