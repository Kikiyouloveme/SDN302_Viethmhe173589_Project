import { AddressSelector } from '@/components/address-selector';
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  LogOut, ShieldCheck, User as UserIcon, MapPin, KeyRound, Package,
  Plus, Pencil, Trash2, Star, Loader2, MailWarning,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { AvatarPicker } from "@/components/ui/avatar-picker";
import { AvatarGlyph } from "@/components/ui/avatar-glyph";
import { useAuth } from "@/context/auth";
import { useToast } from "@/context/toast";
import { api, ApiError, type Address, type Order, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { OrderCard } from "@/components/order-card";

type Tab = "profile" | "addresses" | "orders" | "password";

const ROLE_LABEL: Record<string, string> = {
  admin: "Quản trị viên",
  staff: "Nhân viên",
  customer: "Khách hàng",
};

const TABS: { id: Tab; label: string; icon: typeof UserIcon }[] = [
  { id: "profile", label: "Hồ sơ", icon: UserIcon },
  { id: "orders", label: "Đơn hàng", icon: Package },
  { id: "addresses", label: "Địa chỉ", icon: MapPin },
  { id: "password", label: "Mật khẩu", icon: KeyRound },
];

export default function Account() {
  const { user, logout, setUser } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("profile");

  if (!user) return null; // route đã được bọc Protected

  return (
    <div className="mx-auto max-w-5xl px-5 pb-20">
      <div className="py-10">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight">Tài khoản<span className="text-brand">.</span></h1>
      </div>

      {/* Thẻ thông tin */}
      <div className="rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <AvatarGlyph avatarId={user.avatarId} size={48} className="border border-border" />
            <div className="min-w-0">
              <p className="font-display text-lg font-bold">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
              {user.phone && <p className="text-sm text-muted-foreground">{user.phone}</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={user.role === "customer" ? "secondary" : "brand"}>
              <ShieldCheck className="size-3" /> {ROLE_LABEL[user.role]}
            </Badge>
            <Badge variant={user.emailVerified ? "success" : "warning"}>
              {user.emailVerified ? "Đã xác minh email" : "Chưa xác minh email"}
            </Badge>
            {["admin", "staff"].includes(user.role) && (
              <Button size="sm" variant="outline" asChild><Link to="/admin">Vào quản trị</Link></Button>
            )}
            {user.role==='customer'&&<Button size="sm" variant="outline" asChild><Link to="/designs">Thiết kế của tôi</Link></Button>}
            <Button size="sm" variant="ghost" onClick={() => { logout(); navigate("/"); }}>
              <LogOut /> Đăng xuất
            </Button>
          </div>
        </div>

        {!user.emailVerified && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <MailWarning className="size-4 shrink-0" />
            <span className="flex-1">Xác minh email để có thể đặt hàng.</span>
            <Button size="sm" asChild><Link to="/verify-email">Xác minh ngay</Link></Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mt-8 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 font-display text-sm font-semibold transition-colors",
              tab === t.id ? "border-brand text-brand" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>

      <div className="pt-7">
        {tab === "profile" && <ProfileTab user={user} setUser={setUser} />}
        {tab === "orders" && <OrdersTab />}
        {tab === "addresses" && <AddressesTab user={user} setUser={setUser} />}
        {tab === "password" && <PasswordTab />}
      </div>
    </div>
  );
}

/* ==================== HỒ SƠ ==================== */

function ProfileTab({ user, setUser }: { user: User; setUser: (u: User) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const updated = await api.put<User>("/api/auth/profile", {
        name: String(form.get("name") || "").trim(),
        phone: String(form.get("phone") || "").trim(),
      });
      setUser(updated);
      toast.success("Đã cập nhật thông tin cá nhân");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Không lưu được thông tin");
    } finally {
      setBusy(false);
    }
  }

  async function selectAvatar(avatarId: number) {
    if (avatarId === user.avatarId || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const updated = await api.put<User>("/api/auth/avatar", { avatarId });
      setUser(updated);
      toast.success("Đã đổi ảnh đại diện");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Không đổi được ảnh đại diện");
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="max-w-lg rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6">
        <h2 className="mb-4 font-display text-base font-bold uppercase">Ảnh đại diện</h2>
        <AvatarPicker value={user.avatarId} onSelect={selectAvatar} busy={avatarBusy} />
      </section>

    <form onSubmit={save} className="max-w-lg space-y-5 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6" noValidate>
      <h2 className="font-display text-base font-bold uppercase">Thông tin cá nhân</h2>

      <div>
        <Label htmlFor="name">Họ và tên</Label>
        <Input id="name" name="name" required defaultValue={user.name} className="mt-2" />
      </div>
      <div>
        <Label htmlFor="phone">Số điện thoại</Label>
        <Input id="phone" name="phone" type="tel" inputMode="tel" defaultValue={user.phone} placeholder="0901234567" className="mt-2" />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={user.email} disabled readOnly className="mt-2 opacity-70" />
        <p className="mt-1.5 text-xs text-muted-foreground">
          Email dùng để đăng nhập và nhận thông báo đơn hàng nên không thể tự thay đổi.
        </p>
      </div>

      <Button disabled={busy}>{busy ? <><Loader2 className="animate-spin" /> Đang lưu…</> : "Lưu thay đổi"}</Button>
    </form>
    </div>
  );
}

/* ==================== ĐỔI MẬT KHẨU ==================== */

function PasswordTab() {
  const toast = useToast();
  const { setToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const res = await api.put<{ token: string }>("/api/auth/password", {
        currentPassword: String(data.get("currentPassword") || ""),
        newPassword: String(data.get("newPassword") || ""),
        confirmPassword: String(data.get("confirmPassword") || ""),
      });
      // Token cũ đã bị thu hồi phía server — nhận token mới để không bị đăng xuất
      setToken(res.token);
      form.reset();
      toast.success("Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không đổi được mật khẩu");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-lg space-y-5 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-6" noValidate>
      <h2 className="font-display text-base font-bold uppercase">Đổi mật khẩu</h2>

      <div>
        <Label htmlFor="currentPassword">Mật khẩu hiện tại</Label>
        <Input id="currentPassword" name="currentPassword" type="password" required autoComplete="current-password" className="mt-2" />
      </div>
      <div>
        <Label htmlFor="newPassword">Mật khẩu mới</Label>
        <Input id="newPassword" name="newPassword" type="password" required autoComplete="new-password" className="mt-2" />
        <p className="mt-1.5 text-xs text-muted-foreground">Tối thiểu 8 ký tự, gồm cả chữ và số.</p>
      </div>
      <div>
        <Label htmlFor="confirmPassword">Nhập lại mật khẩu mới</Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" required autoComplete="new-password" className="mt-2" />
      </div>

      {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}

      <Button disabled={busy}>{busy ? <><Loader2 className="animate-spin" /> Đang cập nhật…</> : "Đổi mật khẩu"}</Button>
    </form>
  );
}

/* ==================== ĐỊA CHỈ ==================== */

function AddressesTab({ user, setUser }: { user: User; setUser: (u: User) => void }) {
  const toast = useToast();
  const { refresh } = useAuth();
  const [list, setList] = useState<Address[]>(user.addresses || []);
  const [editing, setEditing] = useState<Address | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const fresh = await api.get<Address[]>("/api/auth/addresses");
    setList(fresh);
    const u = await refresh();
    if (u) setUser(u);
  };

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const get = (k: string) => String(form.get(k) || "").trim();
    const body = {
      fullName: get("fullName"), phone: get("phone"),
      provinceCode: get("provinceCode"), wardCode: get("wardCode"),
      line1: get("line1"), note: get("note"),
      isDefault: form.get("isDefault") === "on",
    };
    setBusy(true);
    try {
      if (editing) await api.put(`/api/auth/addresses/${editing.id}`, body);
      else await api.post("/api/auth/addresses", body);
      await reload();
      setDialogOpen(false);
      setEditing(null);
      toast.success(editing ? "Đã cập nhật địa chỉ" : "Đã thêm địa chỉ mới");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Không lưu được địa chỉ");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.del(`/api/auth/addresses/${deleting.id}`);
      await reload();
      toast.success("Đã xóa địa chỉ");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Không xóa được địa chỉ");
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  async function setDefault(address: Address) {
    try {
      await api.put(`/api/auth/addresses/${address.id}/default`, {});
      await reload();
      toast.success("Đã đặt làm địa chỉ mặc định");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Không cập nhật được");
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-bold uppercase">Sổ địa chỉ</h2>
        <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus /> Thêm địa chỉ</Button>
      </div>

      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center">
          <MapPin className="mx-auto size-7 text-muted-foreground" />
          <p className="mt-3 font-medium">Chưa có địa chỉ nào</p>
          <p className="mt-1 text-sm text-muted-foreground">Thêm địa chỉ để thanh toán nhanh hơn ở lần mua sau.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((address) => (
            <div key={address.id} className={cn("rounded-lg border bg-card p-4", address.isDefault ? "border-brand" : "border-border")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display font-semibold">{address.fullName}</p>
                  <p className="text-sm text-muted-foreground">{address.phone}</p>
                </div>
                {address.isDefault && <Badge variant="brand">Mặc định</Badge>}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {[address.line1, address.ward, address.district, address.province].filter(Boolean).join(", ")}
              </p>
              {address.note && <p className="mt-1 text-xs text-muted-foreground">Ghi chú: {address.note}</p>}

              <div className="mt-3 flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setEditing(address); setDialogOpen(true); }}>
                  <Pencil /> Sửa
                </Button>
                {!address.isDefault && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setDefault(address)}><Star /> Đặt mặc định</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(address)}><Trash2 /> Xóa</Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditing(null); }}
        title={editing ? "Sửa địa chỉ" : "Thêm địa chỉ"}
      >
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div>
            <Label htmlFor="a-fullName">Họ tên người nhận *</Label>
            <Input id="a-fullName" name="fullName" required defaultValue={editing?.fullName ?? user.name} className="mt-2" />
          </div>
          <div>
            <Label htmlFor="a-phone">Số điện thoại *</Label>
            <Input id="a-phone" name="phone" type="tel" inputMode="tel" required defaultValue={editing?.phone ?? user.phone} className="mt-2" />
          </div>
          <AddressSelector defaultValue={editing || undefined} />
          <div>
            <Label htmlFor="a-line1">Địa chỉ chi tiết *</Label>
            <Input id="a-line1" name="line1" required defaultValue={editing?.line1} placeholder="Số nhà, tên đường" className="mt-2" />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="a-note">Ghi chú</Label>
            <Input id="a-note" name="note" defaultValue={editing?.note} placeholder="Giao giờ hành chính…" className="mt-2" />
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm sm:col-span-2">
            <input type="checkbox" name="isDefault" defaultChecked={editing?.isDefault} className="size-4 accent-[var(--brand)]" />
            Đặt làm địa chỉ mặc định
          </label>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="outline" size="sm" onClick={() => { setDialogOpen(false); setEditing(null); }}>Hủy</Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? <><Loader2 className="animate-spin" /> Đang lưu…</> : "Lưu địa chỉ"}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        busy={busy}
        tone="destructive"
        title="Xóa địa chỉ"
        description={`Bạn có chắc muốn xóa địa chỉ của ${deleting?.fullName}? Thao tác này không thể hoàn tác.`}
        confirmLabel="Xóa địa chỉ"
      />
    </>
  );
}

/* ==================== ĐƠN HÀNG ==================== */

function OrdersTab() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<Order[]>("/api/orders/mine")
      .then(setOrders)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Không tải được đơn hàng"));
  }, []);

  if (error) return <p className="text-destructive">{error}</p>;
  if (!orders) return <div className="space-y-3">{[0, 1].map((i) => <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />)}</div>;

  if (!orders.length) {
    return (
      <div className="rounded-lg border border-dashed border-border py-16 text-center">
        <Package className="mx-auto size-7 text-muted-foreground" />
        <p className="mt-3 font-medium">Chưa có đơn hàng nào</p>
        <p className="mt-1 text-sm text-muted-foreground">Các đơn bạn đặt sẽ xuất hiện ở đây.</p>
        <Button className="mt-5" asChild><Link to="/shop">Bắt đầu mua sắm</Link></Button>
      </div>
    );
  }

  return <div className="space-y-3.5">{orders.map((o) => <OrderCard key={o.id} order={o} />)}</div>;
}
