import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, CART_KEY, TOKEN_KEY, USER_KEY, type User } from "@/lib/api";

interface AuthCtx {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (body: Record<string, unknown>) => Promise<User>;
  logout: () => void;
  /** Nạp lại hồ sơ từ server — dùng sau khi xác minh email, đổi địa chỉ… */
  refresh: () => Promise<User | null>;
  /** Cập nhật user trong bộ nhớ khi API đã trả về bản mới */
  setUser: (u: User) => void;
  setToken: (token: string) => void;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
    catch { return null; }
  });
  const [ready, setReady] = useState(false);

  const setUser = useCallback((u: User) => {
    setUserState(u);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  }, []);

  const setToken = useCallback((token: string) => {
    localStorage.setItem(TOKEN_KEY, token);
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    // Giỏ hàng thuộc về người đang đăng nhập. Nếu không dọn, người tiếp theo dùng
    // máy này (thư viện, máy gia đình) sẽ thấy hàng người trước đã chọn.
    localStorage.removeItem(CART_KEY);
    sessionStorage.removeItem(`${CART_KEY}:guest`);
    sessionStorage.removeItem('vela-guest-order');
    sessionStorage.removeItem('vela-guest-order-email');
    setUserState(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!localStorage.getItem(TOKEN_KEY)) { setUserState(null); return null; }
    try {
      const fresh = await api.get<User>("/api/auth/me");
      setUser(fresh);
      return fresh;
    } catch {
      clearSession();
      return null;
    }
  }, [setUser, clearSession]);

  // Xác thực lại token khi mở app — token có thể đã hết hạn hoặc bị thu hồi
  useEffect(() => {
    refresh().finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY || event.key === null) void refresh();
    };
    window.addEventListener('storage', sync);
    window.addEventListener('vela-session-expired', clearSession);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('vela-session-expired', clearSession);
    };
  }, [refresh, clearSession]);

  const store = (token: string, u: User) => {
    sessionStorage.removeItem(`${CART_KEY}:guest`);
    sessionStorage.removeItem('vela-guest-order');
    sessionStorage.removeItem('vela-guest-order-email');
    setToken(token);
    setUser(u);
  };

  const login = async (email: string, password: string) => {
    const r = await api.post<{ token: string; user: User }>("/api/auth/login", { email, password });
    store(r.token, r.user);
    return r.user;
  };

  const register = async (body: Record<string, unknown>) => {
    const r = await api.post<{ token: string; user: User }>("/api/auth/register", body);
    store(r.token, r.user);
    return r.user;
  };

  return (
    <Ctx.Provider value={{ user, ready, login, register, logout: clearSession, refresh, setUser, setToken }}>
      {children}
    </Ctx.Provider>
  );
}
