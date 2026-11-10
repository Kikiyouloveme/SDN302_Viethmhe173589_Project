import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, XCircle, ShieldAlert, Loader2, Package, Copy, QrCode, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api, ApiError, type Order } from "@/lib/api";
import { money } from "@/lib/utils";
import { useCart } from "@/context/cart";
import { useToast } from "@/context/toast";

/** Kết quả trả về khi tạo mã QR chuyển khoản */
interface VietQrInfo {
  payload: string;
  content: string;
  amount: number;
  bank: { bin: string; accountNo: string; accountName: string; accountType: string };
  image: string;
  expiresAt: string;
  ttlMinutes: number;
}

export default function Payment() {
  const {items,setQty}=useCart();
  const toast = useToast();
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const vietqrRequested = params.get("vietqr") === "1";
  const vnp = params.get("vnp"); // paid | failed | invalid | notfound

  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [qr, setQr] = useState<VietQrInfo | null>(null);
  const [qrError, setQrError] = useState("");
  const [qrLoading, setQrLoading] = useState(false);

  useEffect(()=>{
    if(order?.payStatus!=='paid'||!order.userId)return;
    const key=`vela-checkout:${order.userId}`;
    try{const pending=JSON.parse(sessionStorage.getItem(key)||'null');if(pending?.orderId!==order.id)return;sessionStorage.removeItem(key);
      for(const line of order.items){const cartItem=items.find(i=>i.variantId===line.variantId&&i.designRevisionId===line.designRevisionId);if(cartItem)setQty(cartItem.key,Math.max(0,cartItem.qty-line.qty));}
    }catch{/* Storage disabled: keep cart available rather than discard unknown changes. */}
  },[order,items,setQty]);

  const loadOrder = useCallback(() => {
    if (vnp === "invalid" || vnp === "notfound") return Promise.resolve();
    return api.get<Order>("/api/orders/" + orderId)
      .then(setOrder)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Không tải được đơn hàng"));
  }, [orderId, vnp]);

  useEffect(() => { void loadOrder(); }, [loadOrder]);

  const createQr = useCallback(async () => {
    setQrLoading(true);
    setQrError("");
    try {
      const info = await api.post<VietQrInfo>("/api/payment/vietqr/create", { orderId });
      setQr(info);
    } catch (err) {
      setQrError(err instanceof ApiError ? err.message : "Không tạo được mã chuyển khoản");
    } finally {
      setQrLoading(false);
    }
  }, [orderId]);

  // Đơn đang chờ chuyển khoản: tạo mã ngay, không cần khách bấm thêm
  useEffect(() => {
    if (!order || order.payMethod !== "vietqr" || order.payStatus === "paid") return;
    if (!vietqrRequested && !["pending"].includes(order.status)) return;
    void createQr();
    // Chỉ tạo lại khi đơn hoặc cờ URL thay đổi, tránh vòng lặp do createQr đổi tham chiếu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.payStatus, order?.payMethod, vietqrRequested]);

  // Trong lúc chờ cửa hàng xác nhận, tự kiểm tra lại trạng thái mỗi 10 giây
  useEffect(() => {
    if (!order || order.payMethod !== "vietqr" || order.payStatus === "paid") return;
    if (["cancelled", "refunded", "refund_pending"].includes(order.status)) return;
    const timer = setInterval(() => { void loadOrder(); }, 10000);
    return () => clearInterval(timer);
  }, [order, loadOrder]);

  async function payAgain() {
    setError('');
    setRedirecting(true);
    try {
      const { url } = await api.post<{ url: string }>("/api/payment/vnpay/create", { orderId });
      window.location.href = url;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Không tạo được liên kết thanh toán";
      setError(message);
      toast.error(message);
      setRedirecting(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Đã sao chép ${label}`);
    } catch {
      toast.error("Trình duyệt không cho phép sao chép tự động. Vui lòng chọn và sao chép thủ công.");
    }
  }

  /* --- chữ ký callback không hợp lệ --- */
  if (vnp === "invalid") {
    return (
      <Shell>
        <ShieldAlert className="mx-auto size-10 text-destructive" />
        <h1 className="mt-3 font-display text-xl font-bold uppercase">Giao dịch không hợp lệ</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Dữ liệu trả về từ cổng thanh toán không vượt qua bước xác thực chữ ký hoặc số tiền không khớp.
          Giao dịch đã bị từ chối để bảo vệ tài khoản của bạn. Đơn hàng chưa bị trừ tiền.
        </p>
        <div className="mt-6 grid gap-2.5">
          <Button asChild><Link to="/orders">Xem đơn hàng của tôi</Link></Button>
          <Button variant="outline" asChild><Link to="/shop">Tiếp tục mua sắm</Link></Button>
        </div>
      </Shell>
    );
  }

  if (error && !order) {
    return (
      <Shell>
        <h1 className="font-display text-xl font-bold uppercase">{error}</h1>
        <Button className="mt-6" asChild><Link to="/orders">Đơn hàng của tôi</Link></Button>
      </Shell>
    );
  }

  if (!order) {
    return <Shell><Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" /></Shell>;
  }

  const info = (
    <>
      <h1 className="font-display text-2xl font-bold uppercase">Đơn hàng {order.id}</h1>
      <p className="mt-2 font-display text-4xl font-bold">{money(order.total)}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {order.items.length} sản phẩm · Giao tới {order.shippingAddress.fullName}
      </p>
    </>
  );

  const actions = (
    <div className="mt-6 grid gap-2.5">
      <Button asChild><Link to={`/orders/${order.id}`}><Package /> Theo dõi đơn hàng</Link></Button>
      <Button variant="outline" asChild><Link to="/shop">Tiếp tục mua sắm</Link></Button>
    </div>
  );

  /* --- COD --- */
  // Chỉ đơn COD thật sự mới hiện "Đặt hàng thành công". Trước đây `cod ||` cho phép
  // query `?cod=1` đẩy một đơn VNPay/VietQR đang treo hoặc đơn đã huỷ vào nhánh này.
  const isCancelled = order.status === "cancelled" || order.status === "refund_pending" || order.status === "refunded";
  if (isCancelled) {
    return (
      <Shell>
        <Badge variant="warning" className="mb-4">Đơn đã đóng</Badge>
        {info}
        <p className="mt-4 text-sm text-muted-foreground">
          Đơn hàng này đã được huỷ hoặc đã xử lý hoàn tiền. Nếu bạn đã chuyển khoản, cửa hàng sẽ liên hệ để hoàn lại.
        </p>
        {actions}
      </Shell>
    );
  }
  if (order.payMethod === "cod" && order.payStatus !== "paid") {
    return (
      <Shell>
        {info}
        <p className="mt-6 flex items-center justify-center gap-2 font-medium text-emerald-700">
          <CheckCircle2 className="size-5" /> Đặt hàng thành công!
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Bạn sẽ thanh toán khi nhận hàng. Email xác nhận đã được gửi tới {order.customerEmail}.
        </p>
        {actions}
      </Shell>
    );
  }

  /* --- Đã thanh toán --- */
  if (order.payStatus === "paid") {
    return (
      <Shell>
        <Badge variant="success" className="mb-4">Đã thanh toán</Badge>
        {info}
        <p className="mt-6 flex items-center justify-center gap-2 font-medium text-emerald-700">
          <CheckCircle2 className="size-5" />
          {order.payMethod === "vietqr" ? "Cửa hàng đã xác nhận chuyển khoản" : "Thanh toán thành công qua VNPay"}
        </p>
        {order.payment?.transactionNo && (
          <p className="mt-2 text-sm text-muted-foreground">
            Mã giao dịch: <b className="text-foreground">{order.payment.transactionNo}</b>
            {order.payment.bankCode ? ` · Ngân hàng: ${order.payment.bankCode}` : ""}
          </p>
        )}
        {actions}
      </Shell>
    );
  }

  /* --- VietQR: hiện mã chuyển khoản, chờ cửa hàng xác nhận --- */
  if (order.payMethod === "vietqr") {
    return (
      <Shell>
        <Badge variant="warning" className="mb-4">Chờ chuyển khoản</Badge>
        {info}
        {qrLoading && !qr && <p className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tạo mã QR…</p>}
        {qrError && (
          <div className="mt-6 rounded-lg border border-destructive/40 bg-red-50 p-4 text-sm text-red-800">
            <p>{qrError}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void createQr()}><RefreshCcw /> Thử tạo lại mã</Button>
          </div>
        )}
        {qr && (
          <>
            <div className="mt-6 flex flex-col items-center">
              <img src={qr.image} alt={`Mã VietQR chuyển khoản ${money(qr.amount)} cho đơn ${order.id}`} className="size-64 rounded-lg border border-border bg-white p-2" />
              <p className="mt-3 text-xs text-muted-foreground">Quét mã bằng app ngân hàng bất kỳ (VietQR / NAPAS 247)</p>
            </div>
            <dl className="mt-5 space-y-2 rounded-lg border border-border bg-secondary/50 p-4 text-left text-sm">
              <Row label="Ngân hàng" value={qr.bank.accountNo ? `BIN ${qr.bank.bin}` : "—"} onCopy={undefined} />
              <Row label="Số tài khoản" value={qr.bank.accountNo} onCopy={() => void copy(qr.bank.accountNo, "số tài khoản")} />
              <Row label="Chủ tài khoản" value={qr.bank.accountName} onCopy={undefined} />
              <Row label="Số tiền" value={money(qr.amount)} onCopy={() => void copy(String(qr.amount), "số tiền")} />
              <Row label="Nội dung" value={qr.content} onCopy={() => void copy(qr.content, "nội dung chuyển khoản")} />
            </dl>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Chuyển đúng <b className="text-foreground">{money(qr.amount)}</b> và ghi đúng nội dung <b className="text-foreground">{qr.content}</b> để cửa hàng đối soát.
              Sau khi tiền về, nhân viên sẽ xác nhận và đơn chuyển sang trạng thái đã thanh toán.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Mã có hiệu lực {qr.ttlMinutes} phút · tự kiểm tra lại trạng thái mỗi 10 giây.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => void loadOrder()}><RefreshCcw /> Tôi đã chuyển khoản</Button>
              <Button variant="ghost" asChild><Link to={`/orders/${order.id}`}>Xem đơn</Link></Button>
            </div>
          </>
        )}
      </Shell>
    );
  }

  /* --- Thất bại hoặc chờ thanh toán VNPay --- */
  const failed = order.payStatus === "failed" || vnp === "failed";
  return (
    <Shell>
      {failed ? (
        <>
          <XCircle className="mx-auto size-10 text-destructive" />
          <h1 className="mt-3 font-display text-xl font-bold uppercase">Thanh toán chưa thành công</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {order.payment?.message || "Giao dịch không hoàn tất."} Đơn hàng vẫn được giữ, bạn có thể thanh toán lại.
          </p>
        </>
      ) : (
        <>
          <Badge variant="warning" className="mb-4">Chờ thanh toán</Badge>
          {info}
          <p className="mt-4 text-sm text-muted-foreground">
            Đơn hàng chưa được thanh toán. Nhấn nút bên dưới để tới cổng VNPay.
          </p>
        </>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-6 grid gap-2.5">
        <Button variant="brand" onClick={payAgain} disabled={redirecting}>
          {redirecting ? <><Loader2 className="animate-spin" /> Đang chuyển hướng…</> : <><QrCode /> Thanh toán qua VNPay</>}
        </Button>
        {error && (
          <Button variant="outline" onClick={payAgain} disabled={redirecting}>
            Thử lại thanh toán trên đơn này
          </Button>
        )}
        <Button variant="outline" asChild><Link to={`/orders/${order.id}`}>Để sau</Link></Button>
      </div>
    </Shell>
  );
}

function Row({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1.5 text-right font-medium">
        <span className="break-all">{value}</span>
        {onCopy && (
          <button onClick={onCopy} aria-label={`Sao chép ${label.toLowerCase()}`} className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground">
            <Copy className="size-3.5" />
          </button>
        )}
      </dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl px-5 py-16">
      <div className="rounded-lg border border-border bg-card p-6 text-center shadow-sm sm:p-8">{children}</div>
    </div>
  );
}
