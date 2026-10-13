import {
  createRootRoute,
  HeadContent,
  Scripts,
  Outlet,
} from "@tanstack/react-router";
import { AuthKitProvider } from "@workos/authkit-tanstack-react-start/client";
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { title: "Kan — your shared canvas" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
  }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <AuthKitProvider>
          <Outlet />
        </AuthKitProvider>
        <Scripts />
      </body>
    </html>
  ),
});
