const { badRequest } = require('./security');
const fulfillmentStatuses = new Set(['confirmed', 'processing', 'ready_to_ship', 'shipped', 'delivered']);
function guardFulfillment(order, target) {
  if (!fulfillmentStatuses.has(target)) return;
  if(target==='delivered'&&['return_to_sender','returned_to_sender'].includes(order.shipping?.milestone))throw badRequest('Đơn đang hoàn về người gửi không được đánh dấu giao thành công');
  // Mọi phương thức KHÔNG phải COD đều phải có tiền rồi mới được xử lý/giao hàng.
  // Trước đây chỉ chặn vnpay nên đơn chuyển khoản (vietqr) có thể giao khi chưa nhận
  // được đồng nào — hàng ra khỏi kho, doanh thu không bao giờ được ghi nhận.
  if (order.payMethod !== 'cod' && order.payStatus !== 'paid') {
    throw badRequest(`Đơn ${order.payMethod === 'vietqr' ? 'chuyển khoản' : 'thanh toán online'} chưa được xác nhận nhận tiền; chưa được xác nhận, xử lý hoặc giao hàng. Hãy xác nhận đã nhận tiền trước.`);
  }
  if (order.payMethod === 'cod' && target !== 'confirmed' && order.status === 'pending') {
    throw badRequest('Cần xác nhận đơn COD trước khi chuẩn bị hàng.');
  }
}
function permitsFulfillment(order, target) {
  try { guardFulfillment(order, target); return true; } catch { return false; }
}
module.exports = { guardFulfillment, permitsFulfillment };
