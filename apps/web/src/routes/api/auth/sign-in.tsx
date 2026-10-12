import { createFileRoute } from "@tanstack/react-router";
import { getSignInUrl } from "@workos/authkit-tanstack-react-start";
export const Route = createFileRoute("/api/auth/sign-in")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const invite = new URL(request.url).searchParams.get("invite");
        const returnPathname =
          invite && /^[A-Za-z0-9_-]{43}$/.test(invite)
            ? `/?invite=${invite}`
            : "/";
        return new Response(null, {
          status: 307,
          headers: {
            Location: await getSignInUrl({ data: { returnPathname } }),
          },
        });
      },
    },
  },
});
