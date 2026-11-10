/* API client — JWT lưu localStorage */

export type Role = "admin" | "staff" | "customer";

export interface Address {
  id: string;
  fullName: string;
  phone: string;
  province: string;
  district: string;
  ward: string;
  line1: string;
  note?: string;
  isDefault: boolean;
  createdAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  emailVerified: boolean;
  avatarId: number;
  addresses: Address[];
  createdAt: string;
}

export interface Variant {
  id: string;
  sku: string;
  color: string;
  size: string;
  stock: number;
  active: boolean;
}

export interface Product {
  media?: {color:string;viewType:string;localPath:string;altText:string}[];
  id: string;
  title: string;
  price: number;
  compareAtPrice?: number | null;
  cat: string;
  badge: string | null;
  tags: string[];
  variants: Variant[];
  colors: string[];
  sizes: string[];
  totalStock: number;
  inStock: boolean;
  img: string;
  img2: string;
  desc: string;
  active: boolean;
  createdAt: string;
}

export interface OrderItem {
  designRevisionId?: string;
  lineId?: string;
  itemType?: 'regular' | 'custom';
  stockConsumed?: boolean;
  priceBreakdown?: {basePrice:number;frontFee:number;backFee:number;unitTotal:number;printFee?:number;positions?:{position:string;contentType:string;fee:number}[]};
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  color: string;
  size: string;
  price: number;
  compareAtPrice?: number | null;
  qty: number;
  img: string;
}

export interface VoucherSnapshot {
  id?: string;
  code: string;
  percentage: number;
  maxDiscount: number | null;
  discountAmount: number;
  appliedAt?: string;
}

export interface PaymentInfo {
  gateway?: string;
  txnRef?: string;
  transactionNo?: string;
  bankCode?: string;
  code?: string;
  message?: string;
  amount?: number;
  processedAt?: string;
  live?: boolean;
  /** VietQR: nội dung chuyển khoản in trên mã QR */
  reference?: string;
  requestedAt?: string;
  expiresAt?: string;
  confirmedBy?: string;
  source?: string;
}

export type OrderStatus =
  | "pending" | "confirmed" | "processing" | "ready_to_ship" | "shipped" | "delivered"
  | "cancelled" | "return_requested" | "return_approved" | "return_rejected"
  | "returning" | "returned" | "refund_pending" | "refunded";

export interface OrderHistoryEntry {
  at: string;
  status: string;
  actor: string;
  actorId?: string | null;
  note: string;
  visibleToCustomer?: boolean;
}

export interface Order {
  allowedTransitions?: string[];
  id: string;
  userId: string | null;
  customerEmail: string;
  items: OrderItem[];
  shippingAddress: Omit<Address, "id" | "isDefault" | "createdAt">;
  subtotal: number;
  discount: number;
  voucher: VoucherSnapshot | null;
  shippingFee: number;
  total: number;
  payMethod: "cod" | "vnpay" | "vietqr";
  payStatus: "pending" | "paid" | "failed";
  status: OrderStatus;
  stockState?: string;
  payment?: PaymentInfo | null;
  shipping: { carrier: string; trackingNumber: string; handedOverAt: string | null; deliveredAt: string | null; estimatedDeliveryAt?:string|null;milestone?:string;customerNote?:string };
  demo?: boolean;
  cancel?: { reason: string; by: string; at: string } | null;
  refund?: {
    status: "refunded" | "pending_manual" | "pending";
    amount: number; method: string; reference?: string | null;
    statusNote?: string; refundedAt?: string | null;
  } | null;
  /** Tổng đã hoàn, cộng dồn qua nhiều lần hoàn từng phần */
  refundedTotal?: number;
  /** Đơn cần người xử lý thủ công (vd: thanh toán về sau khi đã hủy) */
  needsAttention?: boolean;
  attentionNote?: string;
  history: OrderHistoryEntry[];
  returns?: ReturnRequest[];
  createdAt: string;
}

export interface Quote {
  items: OrderItem[];
  subtotal: number;
  discount: number;
  discountedSubtotal: number;
  shippingFee: number;
  total: number;
  voucher: VoucherSnapshot | null;
  voucherError: string | null;
  freeShipping: boolean;
  freeShippingShortBy: number;
  freeShippingThreshold: number;
}

export interface Voucher {
  id: string;
  code: string;
  percentage: number;
  description: string;
  minOrderValue: number;
  maxDiscount: number | null;
  usageLimit: number | null;
  perUserLimit: number;
  usedCount: number;
  usedByCount?: number;
  active: boolean;
  public: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ReturnItem {
  productId: string;
  variantId: string;
  title: string;
  color: string;
  size: string;
  price: number;
  qty: number;
  img: string;
}

export interface ReturnRequest {
  id: string;
  orderId: string;
  userId: string;
  type: "return" | "exchange";
  status: "pending" | "approved" | "rejected" | "receiving" | "received" | "completed";
  reason: string;
  reasonLabel: string;
  description: string;
  photos: string[];
  items: ReturnItem[];
  refundAmount: number;
  shippingResponsibility: "shop" | "customer";
  exchange?: {
    productId: string; variantId: string;
    title: string; color: string; size: string; qty: number;
    unitPrice: number; originalValue: number; newValue: number; difference: number;
    fulfilledAt?: string;
  } | null;
  grossValue?: number;
  refundStatus?: string;
  bankAccount?: { holder: string; number: string; bank: string } | { masked: true } | null;
  adminNote?: string;
  history: { at: string; status: string; actor: string; note: string }[];
  createdAt: string;
  reviewedAt?: string;
  receivedAt?: string;
}

export interface ReturnEligibility {
  eligible: boolean;
  reason: string | null;
  daysLeft: number;
  deadline: string | null;
  windowDays: number;
  /** Số lượng còn có thể đổi/trả cho từng dòng hàng */
  remainingItems: {
    variantId: string; title: string; color: string; size: string;
    img: string; purchased: number; remaining: number;
  }[];
  reasons: { value: string; label: string }[];
}

/** Gợi ý sản phẩm thay thế cùng giá trị cho yêu cầu đổi hàng */
export interface ExchangeOptions {
  targetValue: number;
  qty: number;
  note: string | null;
  options: {
    id: string;
    title: string;
    price: number;
    img: string;
    variants: { id: string; color: string; size: string; stock: number; inStock: boolean }[];
  }[];
}

export interface Stats {
  products: number;
  activeProducts: number;
  users: number;
  verifiedUsers: number;
  orders: number;
  ordersToday: number;
  pendingOrders: number;
  cancelledOrders: number;
  revenue: number;
  revenueToday: number;
  refunded: number;
  pendingReturns: number;
  rejectedReturns: number;
  refundPending: number;
  totalReturns: number;
  vouchers: number;
  lowStockCount: number;
  lowStock: { id: string; title: string; totalStock: number }[];
  topProducts: { id: string; title: string; qty: number; revenue: number }[];
  daily: { date: string; revenue: number }[];
  emails: number;
  mailMode: "smtp" | "outbox";
  vnpayMode: "live" | "sandbox";
}

export interface MailRecord {
  id: string;
  to: string;
  subject: string;
  template: string;
  mode: "smtp" | "outbox";
  status: "sent" | "failed" | "pending";
  error?: string;
  html?: string | null;
  /** Email chứa mã OTP — nội dung không được hiển thị */
  sensitive?: boolean;
  redactedReason?: string;
  createdAt: string;
}

export const TOKEN_KEY = "vela_token";
export const USER_KEY = "vela_user";
export const CART_KEY = "vela_cart";

export const getToken = () => localStorage.getItem(TOKEN_KEY);

/** Lỗi từ API — giữ lại mã HTTP và mã lỗi nghiệp vụ để UI xử lý riêng */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (!(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = "Bearer " + token;
  headers['X-Print-Session']='1';
  const csrf=sessionStorage.getItem('vela-print-csrf');if(csrf)headers['X-Print-CSRF']=csrf;

  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const payload = data as { error?: string; code?: string };
    // Phiên hết hạn → dọn token để app quay về trạng thái chưa đăng nhập
    if (res.status === 401 && token) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.dispatchEvent(new Event("vela-session-expired"));
    }
    throw new ApiError(payload.error || `Lỗi ${res.status}`, res.status, payload.code);
  }
  return data as T;
}

export const api = {
  async printSession(){const result=await req<{csrf:string}>('/api/print/session',{method:'POST'});sessionStorage.setItem('vela-print-csrf',result.csrf);},
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, body?: unknown) => req<T>(p, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  patch: <T>(p: string, body?: unknown) => req<T>(p, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  put: <T>(p: string, body?: unknown) => req<T>(p, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  del: <T>(p: string) => req<T>(p, { method: "DELETE" }),
  async upload(file: File): Promise<{ url: string }> {
    const fd = new FormData();
    fd.append("image", file);
    return req<{ url: string }>("/api/upload", { method: "POST", body: fd });
  },
};

/* ---------------- nhãn hiển thị ---------------- */

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  processing: "Đang chuẩn bị",
  ready_to_ship: "Sẵn sàng giao",
  shipped: "Đang giao",
  delivered: "Đã giao",
  cancelled: "Đã hủy",
  return_requested: "Yêu cầu đổi/trả",
  return_approved: "Đã duyệt đổi/trả",
  return_rejected: "Từ chối đổi/trả",
  returning: "Đang hoàn hàng",
  returned: "Đã nhận hàng hoàn",
  refund_pending: "Chờ hoàn tiền",
  refunded: "Đã hoàn tiền",
};

export const PAY_STATUS_LABEL: Record<string, string> = {
  pending: "Chờ thanh toán",
  paid: "Đã thanh toán",
  failed: "Thanh toán lỗi",
};

export type BadgeTone = "default" | "brand" | "secondary" | "success" | "destructive" | "warning" | "outline";

export const ORDER_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  confirmed: "success",
  processing: "brand",
  ready_to_ship: "brand",
  shipped: "brand",
  delivered: "success",
  cancelled: "destructive",
  return_requested: "warning",
  return_approved: "warning",
  return_rejected: "destructive",
  returning: "warning",
  returned: "secondary",
  refund_pending: "warning",
  refunded: "secondary",
};

export const PAY_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "secondary",
  paid: "success",
  failed: "destructive",
};
