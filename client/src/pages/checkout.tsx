import {PrivateImage} from '@/components/private-image';
import {GuestCheckout} from '@/components/guest-checkout';
import { useCallback, useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Truck, CreditCard, Loader2, Tag, X, MapPin, Plus, ShieldAlert, Check, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog } from "@/components/ui/dialog";
import { useCart } from "@/context/cart";
import { useAuth } from "@/context/auth";
import { useToast } from "@/context/toast";
import { api, ApiError, type Address, type Order, type Quote } from "@/lib/api";
import { money, cn } from "@/lib/utils";

type PayMethod = "cod" | "vnpay" | "vietqr";

const METHODS: { value: PayMethod; icon: typeof Truck; title: string; desc: string }[] = [
  { value: "cod", icon: Truck, title: "Thanh toán khi nhận hàng (COD)", desc: "Trả tiền mặt cho nhân viên giao hàng" },
  { value: "vnpay", icon: CreditCard, title: "VNPay — thẻ ATM / QR / Internet Banking", desc: "Chuyển tới cổng VNPay để thanh toán an toàn" },
  { value: "vietqr", icon: QrCode, title: "Chuyển khoản VietQR", desc: "Quét mã bằng app ngân hàng, cửa hàng xác nhận khi tiền về" },
];

export default function Checkout(){const {user,ready}=useAuth();return !ready?<p>Đang tải…</p>:user?<AccountCheckout/>:<GuestCheckout/>;}
function AccountCheckout() {
  const { items, payload, clear } = useCart();
  const { user, ready } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const requestKey = useRef(crypto.randomUUID());
  const requestSignature = useRef('');
  const recoveryKey = `vela-checkout:${user?.id}`;
  const [unpaidOrder,setUnpaidOrder]=useState('');
  useEffect(()=>{try{const data=JSON.parse(sessionStorage.getItem(recoveryKey)||'null');if(data){requestKey.current=data.key;requestSignature.current=data.signature;if(data.orderId)void api.get<Order>(`/api/orders/${data.orderId}`).then(order=>{if(order.payStatus==='paid'||['cancelled','refunded','refund_pending'].includes(order.status)){sessionStorage.removeItem(recoveryKey);requestKey.current=crypto.randomUUID();requestSignature.current='';setUnpaidOrder('');}else setUnpaidOrder(data.orderId);}).catch(()=>setUnpaidOrder(data.orderId));}}catch{}},[recoveryKey]);

  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState("");
  const [addressDialog, setAddressDialog] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);

  const [voucherInput, setVoucherInput] = useState("");
  const [appliedVoucher, setAppliedVoucher] = useState("");
  const [voucherError, setVoucherError] = useState("");
  const [checkingVoucher, setCheckingVoucher] = useState(false);

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [pay, setPay] = useState<PayMethod>("cod");
  const [placing, setPlacing] = useState(false);
  // Cổng thanh toán có thể bị tắt (chưa cấu hình) — chỉ hiện lựa chọn thật sự dùng được
  const [vnpayEnabled, setVnpayEnabled] = useState(true);
  const [vietqrEnabled, setVietqrEnabled] = useState(false);

  useEffect(() => {
    api.get<{ vnpayEnabled: boolean; vietqr?: { enabled: boolean } }>("/api/payment/config")
      .then((cfg) => {
        setVnpayEnabled(cfg.vnpayEnabled);
        setVietqrEnabled(Boolean(cfg.vietqr?.enabled));
        if (!cfg.vnpayEnabled) setPay((current) => (current === "vnpay" ? "cod" : current));
      })
      .catch(() => setVnpayEnabled(false));
  }, []);

  const availableMethods = METHODS.filter(
    (m) => (m.value !== "vnpay" || vnpayEnabled) && (m.value !== "vietqr" || vietqrEnabled)
  );

  /* ---------- chặn truy cập khi chưa đủ điều kiện ---------- */
  useEffect(() => {
    if (!ready) return;
    if (!user) navigate("/login", { replace: true, state: { from: "/checkout" } });
    else if (!user.emailVerified) navigate("/verify-email?next=/checkout", { replace: true });
  }, [ready, user, navigate]);

  /* ---------- nạp sổ địa chỉ ---------- */
  useEffect(() => {
    if (!user) return;
    api.get<Address[]>("/api/auth/addresses")
      .then((list) => {
        setAddresses(list);
        const preferred = list.find((a) => a.isDefault) || list[0];
        if (preferred) setAddressId(preferred.id);
      })
      .catch(() => { /* sổ địa chỉ trống — người dùng sẽ thêm mới */ });
  }, [user]);

  /* ---------- lấy báo giá từ server (nguồn số tiền duy nhất) ---------- */
  const fetchQuote = useCallback(async (voucherCode?: string) => {
    if (!items.length) return null as Quote | null;
    setQuoteError("");
    try {
      const result = await api.post<Quote>("/api/orders/quote", {
        items: payload(),
        voucherCode: voucherCode ?? appliedVoucher ?? undefined,
      });
      setQuote(result);
      if (result.voucherError) {
        setVoucherError(result.voucherError);
        setAppliedVoucher("");
      }
      return result;
    } catch (err) {
      setQuoteError(err instanceof ApiError ? err.message : "Không tính được đơn hàng");
      return null as Quote | null;
    }
  }, [items, payload, appliedVoucher]);

  useEffect(() => {
    if (user?.emailVerified) fetchQuote();
    // Phụ thuộc vào chính giỏ hàng chứ không chỉ số dòng: khách tăng/giảm số lượng
    // của một dòng đã có thì `items.length` không đổi, quote cũ vẫn hiển thị và nút
    // đặt hàng gửi `acceptedTotal` cũ — khách thấy một giá, bị tính giá khác.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(payload()), user?.emailVerified]);

  /* ---------- voucher ---------- */
  async function applyVoucher(e: React.FormEvent) {
    e.preventDefault();
    const code = voucherInput.trim().toUpperCase();
    if (!code) return;
    // Chưa có báo giá thì chưa biết giá trị đơn — gửi subtotal 0 sẽ bị từ chối oan
    // ("chưa đạt giá trị tối thiểu") dù giỏ đã đủ điều kiện.
    if (!quote) return toast.error("Đang tính tổng tiền, vui lòng thử lại sau giây lát");
    setCheckingVoucher(true);
    setVoucherError("");
    try {
      const result = await api.post<{ ok: boolean; voucher: { code: string } }>("/api/vouchers/validate", { code, subtotal: quote.subtotal });
      setAppliedVoucher(code);
      const fresh = await fetchQuote(code);
      // Chỉ báo thành công khi báo giá mới thật sự giữ được mã — trước đây vừa toast
      // "Đã áp dụng" vừa hiện lỗi khi mã không còn dùng được cho giỏ này.
      if (fresh?.voucherError) {
        setVoucherError(fresh.voucherError);
        setAppliedVoucher("");
      } else {
        toast.success(`Đã áp dụng mã ${result?.voucher?.code || code}`);
        setVoucherInput("");
      }
    } catch (err) {
      setVoucherError(err instanceof ApiError ? err.message : "Mã giảm giá không hợp lệ");
    } finally {
      setCheckingVoucher(false);
    }
  }

  async function removeVoucher() {
    setAppliedVoucher("");
    setVoucherError("");
    await fetchQuote("");
  }

  /* ---------- thêm địa chỉ ---------- */
  async function saveAddress(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const get = (k: string) => String(form.get(k) || "").trim();
    setSavingAddress(true);
    try {
      const created = await api.post<Address>("/api/auth/addresses", {
        fullName: get("fullName"), phone: get("phone"),
        province: get("province"), district: get("district"), ward: get("ward"),
        line1: get("line1"), note: get("note"),
        isDefault: addresses.length === 0,
      });
      setAddresses((prev) => [...prev, created]);
      setAddressId(created.id);
      setAddressDialog(false);
      toast.success("Đã thêm địa chỉ giao hàng");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Không lưu được địa chỉ");
    } finally {
      setSavingAddress(false);
    }
  }

  /* ---------- đặt hàng ---------- */
  async function placeOrder() {
    if(unpaidOrder){navigate(`/payment/${unpaidOrder}`);return;}
    if (!addressId) return toast.error("Vui lòng chọn địa chỉ giao hàng");
    setPlacing(true);
    const signature=JSON.stringify([payload(),addressId,appliedVoucher,pay,quote?.total]);
    if(requestSignature.current!==signature){requestKey.current=crypto.randomUUID();requestSignature.current=signature;}
    try {
      sessionStorage.setItem(recoveryKey,JSON.stringify({key:requestKey.current,signature}));
      const order = await api.post<Order>("/api/orders", {
        items: payload(),
        addressId,
        voucherCode: appliedVoucher || undefined,
        payMethod: pay,
        acceptedTotal: quote?.total,
        requestKey: requestKey.current,
      });
      if (pay === "vnpay") {
        setUnpaidOrder(order.id);
        sessionStorage.setItem(recoveryKey,JSON.stringify({key:requestKey.current,signature,orderId:order.id}));
        const { url } = await api.post<{ url: string }>("/api/payment/vnpay/create", { orderId: order.id });
        window.location.href = url; // rời SPA sang cổng thanh toán
        return;
      }
      sessionStorage.removeItem(recoveryKey);
      // COD: giỏ đã hoàn tất vai trò → dọn ngay. VietQR thì khách CHƯA trả tiền:
      // giữ giỏ cho tới khi cửa hàng xác nhận, nếu không khách đổi ý/bỏ ngang là
      // mất toàn bộ giỏ và phải chọn lại từ đầu.
      if (pay === "cod") clear();
      // VietQR: sang trang thanh toán để hiện mã QR và chờ cửa hàng xác nhận
      navigate(`/payment/${order.id}${pay === "vietqr" ? "?vietqr=1" : "?cod=1"}`, { replace: true });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Đặt hàng thất bại";
      toast.error(message);
      if (err instanceof ApiError && err.code === "EMAIL_NOT_VERIFIED") {
        navigate("/verify-email?next=/checkout");
      }
      // Hết hàng giữa chừng → cập nhật lại báo giá cho khách thấy
      fetchQuote();
      setPlacing(false);
    }
  }

  if (!ready || !user) {
    return <div className="px-5 py-24 text-center text-muted-foreground">Đang tải…</div>;
  }

  if(unpaidOrder)return <div className="mx-auto max-w-xl space-y-4 px-5 py-16"><h1 className="text-2xl font-bold">Đơn hàng đã được tạo</h1><p>Đơn {unpaidOrder} đang chờ thanh toán. Giỏ hàng vẫn được giữ. Tiếp tục trên đơn này để tránh đặt trùng.</p><Button asChild><Link to={`/payment/${unpaidOrder}`}>Tiếp tục / thử lại thanh toán</Link></Button><p><Link className="underline" to={`/orders/${unpaidOrder}`}>Xem trạng thái hoặc hủy đơn</Link></p></div>;

  if (!items.length) {
    return (
      <div className="px-5 py-24 text-center">
        <h1 className="font-display text-2xl font-bold uppercase">Giỏ hàng trống<span className="text-brand">.</span></h1>
        <p className="mt-3 text-muted-foreground">Hãy chọn vài món trước khi thanh toán.</p>
        <Button className="mt-6" asChild><Link to="/shop">Mua sắm ngay</Link></Button>
      </div>
    );
  }

  const selectedAddress = addresses.find((a) => a.id === addressId);

  return (
    <div className="mx-auto max-w-7xl px-5 pb-20">
      <div className="py-10">
        <nav aria-label="Đường dẫn" className="text-xs uppercase tracking-widest text-muted-foreground">
          <Link to="/" className="hover:text-brand">Trang chủ</Link> / Thanh toán
        </nav>
        <h1 className="mt-2 font-display text-4xl font-bold uppercase tracking-tight">Thanh toán<span className="text-brand">.</span></h1>
      </div>

      <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          {/* Địa chỉ giao hàng */}
          <section className="rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-display text-base font-bold uppercase">Địa chỉ giao hàng</h2>
              <Button size="sm" variant="outline" onClick={() => setAddressDialog(true)}>
                <Plus /> Thêm địa chỉ
              </Button>
            </div>

            {addresses.length === 0 ? (
              <div className="rounded border border-dashed border-border px-4 py-8 text-center">
                <MapPin className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">Bạn chưa có địa chỉ giao hàng nào.</p>
                <Button size="sm" className="mt-4" onClick={() => setAddressDialog(true)}>Thêm địa chỉ đầu tiên</Button>
              </div>
            ) : (
              <div className="grid gap-2.5">
                {addresses.map((address) => (
                  <label
                    key={address.id}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors",
                      addressId === address.id ? "border-brand bg-brand/5" : "border-border hover:border-primary/40"
                    )}
                  >
                    <input
                      type="radio" name="address" className="mt-1 size-4 shrink-0 accent-[var(--brand)]"
                      checked={addressId === address.id}
                      onChange={() => setAddressId(address.id)}
                    />
                    <span className="min-w-0 flex-1 text-sm">
                      <b className="font-display">{address.fullName}</b>
                      <span className="text-muted-foreground"> · {address.phone}</span>
                      {address.isDefault && (
                        <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-semibold uppercase">Mặc định</span>
                      )}
                      <span className="mt-1 block text-muted-foreground">
                        {[address.line1, address.ward, address.district, address.province].filter(Boolean).join(", ")}
                      </span>
                      {address.note && <span className="mt-1 block text-xs text-muted-foreground">Ghi chú: {address.note}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          {/* Phương thức thanh toán */}
          <section className="rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6">
            <h2 className="mb-4 font-display text-base font-bold uppercase">Phương thức thanh toán</h2>
            <div className="grid gap-2.5">
              {availableMethods.map((method) => (
                <label
                  key={method.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors",
                    pay === method.value ? "border-brand bg-brand/5" : "border-border hover:border-primary/40"
                  )}
                >
                  <input
                    type="radio" name="pay" className="mt-1 size-4 shrink-0 accent-[var(--brand)]"
                    checked={pay === method.value}
                    onChange={() => setPay(method.value)}
                  />
                  <method.icon className={cn("mt-0.5 size-5 shrink-0", pay === method.value ? "text-brand" : "text-muted-foreground")} />
                  <span>
                    <b className="block font-display text-sm">{method.title}</b>
                    <small className="text-muted-foreground">{method.desc}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>
        </div>

        {/* Tóm tắt đơn hàng */}
        <aside className="h-fit space-y-4 lg:sticky lg:top-24">
          <section className="rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6">
            <h2 className="font-display text-base font-bold uppercase">Đơn hàng</h2>

            <ul className="mt-4 space-y-3">
              {items.map((item) => (
                <li key={item.key} className="flex gap-3">
                  <PrivateImage src={item.img} alt="" width={48} height={60} className="h-15 w-12 shrink-0 rounded border border-border object-cover" />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">{item.color} / {item.size} × {item.qty}</p>
                    {item.itemType === 'custom' && <p className="text-xs">In theo thiết kế riêng · giá được kiểm tra lại bên dưới</p>}
                  </div>
                  <span className="text-sm font-medium">{money(item.price * item.qty)}</span>
                </li>
              ))}
            </ul>

            {/* Mã giảm giá */}
            <div className="mt-5 border-t border-border pt-4">
              {appliedVoucher && quote?.voucher ? (
                <div className="flex items-center justify-between gap-3 rounded border border-emerald-600/30 bg-emerald-50 px-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2 text-sm text-emerald-900">
                    <Tag className="size-4 shrink-0" />
                    <b className="truncate">{quote.voucher.code}</b>
                    <span className="shrink-0">−{money(quote.voucher.discountAmount)}</span>
                  </span>
                  <button
                    onClick={removeVoucher}
                    aria-label="Bỏ mã giảm giá"
                    className="-m-1 shrink-0 cursor-pointer p-1 text-emerald-800 hover:text-emerald-950"
                  ><X className="size-4" /></button>
                </div>
              ) : (
                <form onSubmit={applyVoucher} className="flex gap-2">
                  <Input
                    value={voucherInput}
                    onChange={(e) => { setVoucherInput(e.target.value); setVoucherError(""); }}
                    placeholder="Nhập mã giảm giá"
                    aria-label="Mã giảm giá"
                    aria-invalid={!!voucherError}
                    className="h-11 uppercase"
                  />
                  <Button type="submit" variant="outline" disabled={checkingVoucher || !voucherInput.trim() || !quote} className="shrink-0">
                    {checkingVoucher ? <Loader2 className="animate-spin" /> : "Áp dụng"}
                  </Button>
                </form>
              )}
              {voucherError && <p role="alert" className="mt-2 text-sm text-destructive">{voucherError}</p>}
            </div>

            {/* Số tiền — hoàn toàn lấy từ server */}
            {quote ? (
              <div className="mt-5 space-y-2 border-t border-border pt-4 text-sm">
                <div className="flex justify-between"><span>Tạm tính</span><span>{money(quote.subtotal)}</span></div>
                {quote.items.filter(i=>i.priceBreakdown).map(i=><p key={i.lineId} className="text-xs">{i.title}: áo {money(i.priceBreakdown!.basePrice)} + in {money(i.priceBreakdown!.frontFee+i.priceBreakdown!.backFee)} × {i.qty}</p>)}
                {quote.discount > 0 && (
                  <div className="flex justify-between text-emerald-700">
                    <span>Giảm giá{quote.voucher ? ` (${quote.voucher.code})` : ""}</span>
                    <span>−{money(quote.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Phí vận chuyển</span>
                  <span className={quote.shippingFee === 0 ? "font-medium text-emerald-700" : ""}>
                    {quote.shippingFee === 0 ? "Miễn phí" : money(quote.shippingFee)}
                  </span>
                </div>

                {quote.freeShipping ? (
                  <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2.5 py-2 text-xs text-emerald-800">
                    <Check className="size-3.5 shrink-0" /> Đơn hàng của bạn được miễn phí vận chuyển
                  </p>
                ) : (
                  <p className="rounded bg-secondary px-2.5 py-2 text-xs text-muted-foreground">
                    Mua thêm <b className="text-foreground">{money(quote.freeShippingShortBy)}</b> để được miễn phí vận chuyển
                  </p>
                )}

                <div className="flex justify-between border-t border-border pt-3 font-display text-lg font-bold">
                  <span>Tổng cộng</span><span>{money(quote.total)}</span>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-2 border-t border-border pt-4" aria-busy="true">
                {[0, 1, 2].map((i) => <div key={i} className="h-4 animate-pulse rounded bg-muted" />)}
              </div>
            )}

            {quoteError && (
              <p role="alert" className="mt-4 flex items-start gap-2 rounded border border-destructive/30 bg-red-50 px-3 py-2.5 text-sm text-destructive">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {quoteError}
              </p>
            )}

            <Button
              className="mt-5 w-full" size="lg"
              onClick={placeOrder}
              disabled={placing || !quote || !addressId || !!quoteError}
            >
              {placing
                ? <><Loader2 className="animate-spin" /> Đang xử lý…</>
                : !quote ? "Đang tính tổng tiền…"
                : pay === "vnpay" ? `Thanh toán VNPay · ${money(quote.total)}`
                : pay === "vietqr" ? `Đặt hàng & nhận mã QR · ${money(quote.total)}` : "Đặt hàng"}
            </Button>

            {!addressId && addresses.length > 0 && (
              <p className="mt-2 text-center text-xs text-muted-foreground">Vui lòng chọn địa chỉ giao hàng</p>
            )}
          </section>

          {selectedAddress && (
            <p className="px-1 text-xs leading-relaxed text-muted-foreground">
              Giao tới <b className="text-foreground">{selectedAddress.fullName}</b> — {selectedAddress.phone},{" "}
              {[selectedAddress.line1, selectedAddress.ward, selectedAddress.district, selectedAddress.province].filter(Boolean).join(", ")}
            </p>
          )}
        </aside>
      </div>

      {/* Hộp thoại thêm địa chỉ */}
      <Dialog open={addressDialog} onClose={() => setAddressDialog(false)} title="Thêm địa chỉ giao hàng">
        <form id="address-form" onSubmit={saveAddress} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div>
            <Label htmlFor="fullName">Họ tên người nhận *</Label>
            <Input id="fullName" name="fullName" required defaultValue={user.name} className="mt-2" />
          </div>
          <div>
            <Label htmlFor="phone">Số điện thoại *</Label>
            <Input id="phone" name="phone" type="tel" inputMode="tel" required defaultValue={user.phone} placeholder="0901234567" className="mt-2" />
          </div>
          <div>
            <Label htmlFor="province">Tỉnh / Thành phố *</Label>
            <Input id="province" name="province" required placeholder="TP. Hồ Chí Minh" className="mt-2" />
          </div>
          <div>
            <Label htmlFor="district">Quận / Huyện *</Label>
            <Input id="district" name="district" required placeholder="Quận 1" className="mt-2" />
          </div>
          <div>
            <Label htmlFor="ward">Phường / Xã *</Label>
            <Input id="ward" name="ward" required placeholder="Phường Bến Nghé" className="mt-2" />
          </div>
          <div>
            <Label htmlFor="line1">Địa chỉ chi tiết *</Label>
            <Input id="line1" name="line1" required placeholder="Số nhà, tên đường" className="mt-2" />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="note">Ghi chú giao hàng</Label>
            <Input id="note" name="note" placeholder="Giao giờ hành chính…" className="mt-2" />
          </div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setAddressDialog(false)}>Hủy</Button>
            <Button type="submit" size="sm" disabled={savingAddress}>
              {savingAddress ? <><Loader2 className="animate-spin" /> Đang lưu…</> : "Lưu địa chỉ"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
