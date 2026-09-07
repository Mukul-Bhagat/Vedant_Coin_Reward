import { authenticate } from "../shopify.server";
import {
  getCoinBalance,
  reconcileCoinReservation,
  releaseCoinReservation,
  releaseExpiredCoinReservations,
  reserveCoins,
} from "../services/coins.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "NO_SHOP_SESSION" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!customerId) return json({ error: "CUSTOMER_NOT_LOGGED_IN" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }

  const cartToken = String(body?.cartToken || "");
  const reservationId = String(body?.reservationId || "");
  const cartFingerprint = String(body?.cartFingerprint || "");
  const reconcile = body?.reconcile === true;
  const coins = Number(body?.coins);
  const requestedCoins = Math.floor(coins);
  if (!cartToken) return json({ error: "CART_TOKEN_REQUIRED" }, 400);
  if (!Number.isFinite(coins) || requestedCoins < 0) {
    return json({ error: "INVALID_COIN_AMOUNT" }, 400);
  }

  const shop = session.shop;
  const customer = String(customerId);

  try {
    await releaseExpiredCoinReservations({ shop, customerId: customer });

    if (requestedCoins === 0) {
      const result = reconcile
        ? await reconcileCoinReservation({
            shop,
            customerId: customer,
            reservationId: reservationId || null,
            cartToken,
            cartFingerprint,
            description: "Cart changed; coin reservation released",
          })
        : await releaseCoinReservation({
            shop,
            customerId: customer,
            reservationId: reservationId || null,
            cartToken,
            description: "Coins removed from cart",
          });
      const stillActive = result.reservation?.status === "ACTIVE" && !result.released;
      return json({
        success: true,
        released: Boolean(result.released),
        status: stillActive ? "ACTIVE" : "NONE",
        coinsReserved: stillActive ? result.reservation.coins : 0,
        reservedCoins: stillActive ? result.reservation.coins : 0,
        availableCoins: result.balance ?? await getCoinBalance(shop, customer),
      });
    }

    const result = await reserveCoins({
      shop,
      customerId: customer,
      cartToken,
      cartFingerprint: cartFingerprint || null,
      requestedCoins,
      description: "Coins reserved for cart checkout",
    });

    console.log("[coin-reserve] request", {
      shop,
      customerId: customer,
      cartToken,
      coins: requestedCoins,
      reservationId: result.reservation.id,
      duplicate: result.duplicate,
    });

    return json({
      success: true,
      status: "ACTIVE",
      reservationId: result.reservation.id,
      coinsReserved: result.reservation.coins,
      reservedCoins: result.reservedCoins,
      expiresAt: result.reservation.expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("[coin-reserve] request failed", {
      shop,
      customerId: customer,
      cartToken,
      requestedCoins,
      error,
    });
    const message = error instanceof Error ? error.message : "COIN_RESERVATION_FAILED";
    const status = message.includes("belongs to another customer") ? 403 : 400;
    return json({ error: message }, status);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
