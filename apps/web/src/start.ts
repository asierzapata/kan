import { createStart, createCsrfMiddleware } from "@tanstack/react-start";
import { authkitMiddleware } from "@workos/authkit-tanstack-react-start";
// Isolated auth fixture; provider credentials remain server-side.
export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
    authkitMiddleware(),
  ],
}));
