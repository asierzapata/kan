import { eveChannel } from "eve/channels/eve";
import type { AuthFn } from "eve/channels/auth";

const stagingService: AuthFn<Request> = async (request) => {
  if (
    !process.env.STAGING_SECRET ||
    request.headers.get("authorization") !==
      `Bearer ${process.env.STAGING_SECRET}`
  )
    return null;
  return {
    authenticator: "kan-staging-service",
    principalId: "kan-staging",
    principalType: "app",
    attributes: {},
  };
};
export default eveChannel({ auth: stagingService });
