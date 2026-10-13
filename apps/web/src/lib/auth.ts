import { useCallback, useEffect, useState } from "react";

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/me", { signal: controller.signal })
      .then(async (response) => (response.ok ? (await response.json()).user : null))
      .catch(() => null)
      .then((next) => {
        if (controller.signal.aborted) return;
        setUser(next);
        setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const signOut = useCallback(async () => {
    const response = await fetch("/api/auth/sign-out", { method: "POST" });
    const { url } = response.ok ? await response.json() : { url: "/" };
    window.location.assign(url);
  }, []);
  return { user, loading, signOut };
}
