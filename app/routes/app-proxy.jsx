import { authenticate } from "../shopify.server";
import { getCoinBalance } from "../services/coins.server";

export const loader = async ({ request }) => {
  const requestUrl = new URL(request.url);
  console.log("[coin-proxy] ENTER", {
    url: requestUrl.origin + requestUrl.pathname,
    pathname: requestUrl.pathname,
    query: Object.fromEntries(
      [...requestUrl.searchParams].filter(
        ([key]) => !["signature", "hmac", "timestamp"].includes(key),
      ),
    ),
  });

  try {
    const { session } = await authenticate.public.appProxy(request);
    console.log("[coin-proxy] AUTHENTICATED", {
      shop: session?.shop || null,
    });
    if (!session) return json({ error: "NO_SHOP_SESSION" }, 401);

    const customerId = requestUrl.searchParams.get("logged_in_customer_id");
    console.log("[coin-proxy] CUSTOMER", { customerId: customerId || null });
    if (!customerId) return json({ error: "CUSTOMER_NOT_LOGGED_IN" }, 401);

    const availableCoins = await getCoinBalance(session.shop, String(customerId));
    console.log("[coin-proxy] BALANCE", { availableCoins });
    console.log("[coin-balance] read", { shop: session.shop, customerId: String(customerId), availableCoins });
    return json({ availableCoins });
  } catch (error) {
    console.error("[coin-balance] request failed", {
      route: "GET /apps/coins",
      errorName: error instanceof Response ? "Response" : error?.name || "UnknownError",
      errorMessage: error instanceof Response
        ? `HTTP ${error.status}`
        : error?.message || String(error),
      prismaCode: error?.code || null,
      prismaClientVersion: error?.clientVersion || null,
      status: error?.status || null,
    });
    if (error instanceof Response) return error;
    return json({ error: "COIN_BALANCE_UNAVAILABLE" }, 500);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
