import { ProductReviews } from "@/components/product-reviews";
import { CustomProduct } from "@/components/custom-product";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Minus, Plus, ShoppingBag, Truck, RefreshCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCart } from "@/context/cart";
import { useToast } from "@/context/toast";
import { api, type Product, type Variant } from "@/lib/api";
import { money, cn } from "@/lib/utils";
import { usePageMeta } from "@/lib/use-page-meta";

export default function ProductPage() {
  const { id } = useParams();
  const { add } = useCart();
  const toast = useToast();

  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [qty, setQty] = useState(1);
  const [image, setImage] = useState("");

  useEffect(() => {
    setProduct(null);
    setError("");
    api.get<Product>("/api/products/" + id)
      .then((p) => {
        setProduct(p);
        setImage(p.img);
        // Mặc định chọn màu đầu tiên còn hàng
        const firstAvailable = p.colors.find((c) => p.variants.some((v) => v.color === c && v.stock > 0));
        setColor(firstAvailable || p.colors[0] || "");
      })
      .catch((e) => setError(e.message));
  }, [id]);

  // Metadata theo từng sản phẩm — quan trọng cho SEO và khi chia sẻ liên kết
  usePageMeta({
    title: product ? `${product.title} — VELATHIER` : "Đang tải sản phẩm — VELATHIER",
    description: product
      ? `${product.desc || product.title}. Giá ${product.price.toLocaleString("vi-VN")}₫. ${product.colors.length} màu, size ${product.sizes.join(", ")}.`
      : undefined,
    image: product?.img,
    canonicalPath: id ? `/product/${id}` : undefined,
  });

  /** Các size của màu đang chọn, kèm tồn kho từng size */
  const sizesForColor = useMemo(() => {
    if (!product || !color) return [] as Variant[];
    return product.variants.filter((v) => v.color === color);
  }, [product, color]);

  // Khi đổi màu: giữ size cũ nếu màu mới cũng có, ngược lại KHÔNG tự chọn hộ.
  // Size là quyết định của khách (đổi/trả vì "không vừa size" là lý do phổ biến nhất);
  // web bán quần áo thật luôn để khách chủ động bấm chọn.
  useEffect(() => {
    if (!sizesForColor.length) return;
    const keep = sizesForColor.find((v) => v.size === size && v.stock > 0);
    if (keep) return;
    setSize("");
    setQty(1);
  }, [sizesForColor]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedVariant = sizesForColor.find((v) => v.size === size) || null;
  useEffect(() => { const media=product?.media?.find(m=>m.color===color);if(media)setImage(media.localPath); },[product,color]);
  const canAdd = !!selectedVariant && selectedVariant.stock > 0;

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-24 text-center">
        <h1 className="font-display text-2xl font-bold uppercase">Không tìm thấy sản phẩm</h1>
        <p className="mt-3 text-muted-foreground">Sản phẩm có thể đã ngừng kinh doanh hoặc đường dẫn không đúng.</p>
        <Button className="mt-6" asChild><Link to="/shop">Xem sản phẩm khác</Link></Button>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="mx-auto max-w-7xl px-5 py-10" aria-busy="true">
        <div className="grid gap-12 lg:grid-cols-2">
          <div className="aspect-[3/4] animate-pulse rounded bg-muted" />
          <div className="space-y-4">
            <div className="h-9 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-7 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-24 w-full animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    );
  }

  const gallery = (product.media?.filter(m=>m.color===color).map(m=>m.localPath)||[product.img,product.img2]).filter((x, i, arr) => x && arr.indexOf(x) === i);
  const onSale = !!product.compareAtPrice && product.compareAtPrice > product.price;
  const off = onSale ? Math.round((1 - product.price / product.compareAtPrice!) * 100) : 0;

  function addToCart() {
    if (!product || !selectedVariant) return;
    add(product, selectedVariant, qty);
    toast.success(`Đã thêm ${product.title} (${selectedVariant.color} / ${selectedVariant.size}) vào giỏ`);
  }

  return (
    <div className="mx-auto max-w-7xl px-5 pb-20">
      <nav aria-label="Đường dẫn" className="py-8 text-xs uppercase tracking-widest text-muted-foreground">
        <Link to="/" className="hover:text-brand">Trang chủ</Link>
        {" / "}
        <Link to="/shop" className="hover:text-brand">Shop</Link>
        {" / "}
        <span className="text-foreground">{product.title}</span>
      </nav>

      <div className="grid gap-12 lg:grid-cols-2">
        {/* Ảnh */}
        <div>
          <div className="aspect-[3/4] overflow-hidden rounded bg-muted">
            <img src={image} alt={product.title} width={600} height={800} fetchPriority="high" decoding="async" onError={e=>{e.currentTarget.onerror=null;e.currentTarget.src='/assets/img/media-unavailable.svg';}} className="h-full w-full object-cover" />
          </div>
          {gallery.length > 1 && (
            <div className="mt-3 flex gap-2.5">
              {gallery.map((g, i) => (
                <button key={i} onClick={() => setImage(g)} className="cursor-pointer p-1" aria-label={`Xem ảnh ${i + 1}`}>
                  <img
                    src={g} alt="" width={76} height={96} loading="lazy"
                    className={cn("h-24 w-19 rounded border object-cover", image === g ? "border-brand" : "border-border")}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Thông tin */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          {product.badge && <Badge variant="brand" className="mb-3">{product.badge}</Badge>}
          <h1 className="font-display text-3xl font-bold uppercase tracking-tight">{product.title}</h1>

          <p className="mt-3 flex flex-wrap items-baseline gap-3">
            {onSale && <s className="font-display text-lg font-medium text-muted-foreground">{money(product.compareAtPrice!)}</s>}
            <span className="font-display text-3xl font-bold text-brand">{money(product.price)}</span>
            {onSale && <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-bold text-destructive">−{off}%</span>}
          </p>

          {/* Màu sắc */}
          <fieldset className="mt-7">
            <legend className="font-display text-xs font-bold uppercase tracking-[0.16em]">
              Màu sắc: <span className="font-normal normal-case tracking-normal text-muted-foreground">{color}</span>
            </legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {product.colors.map((c) => {
                const stockOfColor = product.variants.filter((v) => v.color === c).reduce((s, v) => s + v.stock, 0);
                const soldOut = stockOfColor === 0;
                return (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    disabled={soldOut}
                    aria-pressed={color === c}
                    className={cn(
                      "min-h-11 cursor-pointer rounded border px-4 text-sm font-medium transition-colors",
                      color === c ? "border-brand bg-brand/10 text-brand" : "border-border bg-card hover:border-primary",
                      soldOut && "cursor-not-allowed opacity-45 line-through"
                    )}
                  >
                    {c}
                    {soldOut && <span className="ml-1.5 text-xs">(hết)</span>}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Size — chỉ hiện size thuộc màu đang chọn */}
          <fieldset className="mt-6">
            <legend className="font-display text-xs font-bold uppercase tracking-[0.16em]">Size</legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {sizesForColor.map((variant) => {
                const soldOut = variant.stock === 0;
                return (
                  <button
                    key={variant.id}
                    onClick={() => { setSize(variant.size); setQty(1); }}
                    disabled={soldOut}
                    aria-pressed={size === variant.size}
                    title={soldOut ? "Hết hàng" : `Còn ${variant.stock} sản phẩm`}
                    className={cn(
                      "relative min-h-11 min-w-12 cursor-pointer rounded border px-3.5 text-sm font-semibold transition-colors",
                      size === variant.size ? "border-brand bg-brand text-white" : "border-border bg-card hover:border-primary",
                      soldOut && "cursor-not-allowed border-border/60 text-muted-foreground/50 line-through hover:border-border/60"
                    )}
                  >
                    {variant.size}
                  </button>
                );
              })}
            </div>
            {selectedVariant && (
              <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
                {selectedVariant.stock === 0
                  ? <span className="font-medium text-destructive">Phiên bản này đã hết hàng</span>
                  : selectedVariant.stock <= 5
                    ? <span className="font-medium text-amber-700">Chỉ còn {selectedVariant.stock} sản phẩm</span>
                    : `Còn hàng · SKU ${selectedVariant.sku}`}
              </p>
            )}
          </fieldset>

          {/* Số lượng + thêm vào giỏ */}
          <div className="mt-7 flex gap-3">
            <span className="inline-flex items-stretch rounded border border-input bg-card">
              <button
                className="grid w-11 cursor-pointer place-items-center disabled:opacity-40"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                disabled={qty <= 1}
                aria-label="Giảm số lượng"
              ><Minus className="size-4" /></button>
              <span className="grid w-11 place-items-center font-bold" aria-live="polite">{qty}</span>
              <button
                className="grid w-11 cursor-pointer place-items-center disabled:opacity-40"
                onClick={() => setQty((q) => Math.min(q + 1, selectedVariant?.stock ?? 1, 20))}
                disabled={!canAdd || qty >= Math.min(selectedVariant?.stock ?? 1, 20)}
                aria-label="Tăng số lượng"
              ><Plus className="size-4" /></button>
            </span>
            <Button className="flex-1" size="lg" disabled={!canAdd} onClick={addToCart}>
              <ShoppingBag /> {canAdd ? "Thêm vào giỏ" : size ? "Hết hàng" : "Vui lòng chọn size"}
            </Button>
          </div>

          {/* Cam kết */}
          <CustomProduct product={product} variant={selectedVariant}/>
          <ul className="mt-7 space-y-2.5 border-t border-border pt-6 text-sm text-muted-foreground">
            <li className="flex items-center gap-2.5"><Truck className="size-4 shrink-0 text-brand" /> Miễn phí vận chuyển cho đơn từ 750.000₫</li>
            <li className="flex items-center gap-2.5"><RefreshCcw className="size-4 shrink-0 text-brand" /> Đổi sang món cùng giá trị hoặc trả hàng trong 7 ngày</li>
            <li className="flex items-center gap-2.5"><ShieldCheck className="size-4 shrink-0 text-brand" /> Bảo hành đường may 30 ngày</li>
          </ul>

          {product.desc && (
            <div className="mt-6 border-t border-border pt-6 text-sm leading-relaxed text-muted-foreground">
              {product.desc}
            </div>
          )}
        </div>
      </div>
      <ProductReviews productId={product.id} />
    </div>
  );
}
