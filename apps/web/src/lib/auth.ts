import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ baseURL: window.location.origin });

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export function useAuth() {
  const session = authClient.useSession();
  const data = session.data?.user;
  const user: AuthUser | null = data ? { id: data.id, email: data.email, name: data.name } : null;
  async function signOut() {
    await authClient.signOut();
    window.location.assign("/");
  }
  return { user, loading: session.isPending, signOut };
}
