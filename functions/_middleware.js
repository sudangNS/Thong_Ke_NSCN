/**
 * Đổi các thẻ meta chia sẻ link (og:url, og:image, twitter:image) từ đường dẫn tương đối
 * sang URL tuyệt đối theo tên miền đang truy cập. Facebook/Zalo/Messenger bắt buộc URL tuyệt đối,
 * làm ở đây để không phải sửa index.html khi đổi tên miền (pages.dev ↔ tên miền riêng).
 * Chỉ xử lý phản hồi HTML; API và file tĩnh khác đi qua nguyên vẹn.
 */
export async function onRequest({ request, next }) {
  const res = await next();
  if (!(res.headers.get('Content-Type') || '').includes('text/html')) return res;

  const origin = new URL(request.url).origin;
  const absolutize = {
    element(el) {
      const v = el.getAttribute('content');
      if (v && v.startsWith('/')) el.setAttribute('content', origin + v);
    },
  };
  return new HTMLRewriter()
    .on('meta[property="og:url"], meta[property="og:image"], meta[name="twitter:image"]', absolutize)
    .transform(res);
}
