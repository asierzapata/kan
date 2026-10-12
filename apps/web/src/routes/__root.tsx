import {
  createRootRoute,
  HeadContent,
  Scripts,
  Outlet,
} from "@tanstack/react-router";
import { AuthKitProvider } from "@workos/authkit-tanstack-react-start/client";
export const Route = createRootRoute({
  component: () => (
    <html>
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
