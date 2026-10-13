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
