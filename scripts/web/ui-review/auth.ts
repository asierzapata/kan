export function useAuth() {
  return {
    user: new URL(location.href).searchParams.has("signed-out")
      ? null
      : { id: "qa-user", email: "qa@example.test" },
    loading: false,
    signOut: async () => {
      location.href = "?signed-out";
    },
  };
}

const unavailable = async () => ({ error: { message: "The UI fixture has no auth backend." } });
export const authClient = { signIn: { email: unavailable }, signUp: { email: unavailable } };
