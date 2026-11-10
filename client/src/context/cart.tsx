import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CART_KEY, type Product, type Variant } from "@/lib/api";
import { useAuth } from "./auth";
import { cartLineKey } from '@/lib/cart-identity';

/**
 * Giỏ hàng lưu ở localStorage. Chỉ giữ thông tin nhận dạng và số lượng —
 * giá hiển thị ở đây chỉ để xem trước, khi đặt hàng server luôn tính lại từ database.
 */
export interface CartItem {
  printSummary?:string;
  basePrice?:number;
  printFee?:number;
  itemType?: 'regular' | 'custom';
  designRevisionId?: string;
  qualityAcknowledged?: boolean;
  key: string;        // = variantId, một biến thể chỉ có một dòng trong giỏ
  productId: string;
  variantId: string;
  title: string;
  color: string;
  size: string;
  price: number;
  img: string;
  qty: number;
  maxStock: number;   // dùng để chặn tăng quá tồn kho ngay trên giao diện
}

interface CartCtx {
  items: CartItem[];
  count: number;
  subtotal: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  add: (product: Product, variant: Variant, qty?: number) => void;
  addCustom: (product: Product, variant: Variant, revisionId: string, price: number, quality: boolean, qty?:number,printSummary?:string) => void;
  setQty: (key: string, qty: number) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** Dòng hàng rút gọn để gửi lên API */
  payload: () => { productId: string; variantId: string; qty: number }[];
}

const Ctx = createContext<CartCtx>(null!);
export const useCart = () => useContext(Ctx);

export function CartProvider({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return null;
  const owner = user ? `user:${user.id}` : 'guest';
  return <OwnedCartProvider key={owner} owner={owner}>{children}</OwnedCartProvider>;
}

function OwnedCartProvider({ children, owner }: { children: ReactNode; owner: string }) {
  const storage = owner === 'guest' ? sessionStorage : localStorage;
  const storageKey = `${CART_KEY}:${owner}`;
  const [items, setItems] = useState<CartItem[]>(() => {
    try {
      const parsed = JSON.parse(storage.getItem(storageKey) || "[]");
      // Bỏ qua dữ liệu giỏ hàng theo định dạng cũ (trước khi có biến thể)
      return Array.isArray(parsed) ? parsed.filter((i) => i && i.variantId && i.productId).map(i=>({...i,key:cartLineKey(i.variantId,i.designRevisionId)})) : [];
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Old shared carts have no trustworthy owner and must not be migrated.
    localStorage.removeItem(CART_KEY);
    storage.setItem(storageKey, JSON.stringify(items));
  }, [items, storage, storageKey]);

  const add = (product: Product, variant: Variant, qty = 1) => {
    const key=cartLineKey(variant.id);
    setItems((prev) => {
      const existing = prev.find((i) => i.key === key);
      if (existing) {
        const nextQty = Math.min(existing.qty + qty, variant.stock, 20);
        return prev.map((i) => (i.key === key ? { ...i, qty: nextQty, maxStock: variant.stock } : i));
      }
      return [...prev, {
        key,
        productId: product.id,
        variantId: variant.id,
        title: product.title,
        color: variant.color,
        size: variant.size,
        price: product.price,
        img: product.img,
        qty: Math.min(qty, variant.stock, 20),
        maxStock: variant.stock,
      }];
    });
    setOpen(true);
  };

  const setQty = (key: string, qty: number) =>
    setItems((prev) =>
      qty <= 0
        ? prev.filter((i) => i.key !== key)
        // `i.maxStock || 20` biến tồn kho 0 thành 20 — dòng đã hết hàng vẫn tăng được
        // tới 20 trên giao diện rồi mới bị server từ chối ở bước báo giá.
        : prev.map((i) => (i.key === key ? { ...i, qty: Math.min(qty, Math.max(1, i.maxStock ?? 20), 20) } : i))
    );

  const remove = (key: string) => setItems((prev) => prev.filter((i) => i.key !== key));
  const addCustom = (product:Product,variant:Variant,revisionId:string,price:number,quality:boolean,qty=1,printSummary='') => {
    const key = cartLineKey(variant.id,revisionId);
    setItems(prev => { const existing=prev.find(i=>i.key===key);return existing?prev.map(i=>i.key===key?{...i,qty:Math.min(i.qty+qty,variant.stock,20)}:i):[...prev,{key,productId:product.id,variantId:variant.id,title:product.title,color:variant.color,size:variant.size,price,img:product.img,qty:Math.min(qty,variant.stock,20),maxStock:variant.stock,itemType:'custom',designRevisionId:revisionId,qualityAcknowledged:quality,basePrice:product.price,printFee:price-product.price,printSummary}]; });
    setOpen(true);
  };
  const clear = () => setItems([]);
  const payload = () => items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty, itemType:i.itemType||'regular',designRevisionId:i.designRevisionId,qualityAcknowledged:i.qualityAcknowledged }));

  const count = items.reduce((s, i) => s + i.qty, 0);
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);

  return (
    <Ctx.Provider value={{ items, count, subtotal, open, setOpen, add, addCustom, setQty, remove, clear, payload }}>
      {children}
    </Ctx.Provider>
  );
}
