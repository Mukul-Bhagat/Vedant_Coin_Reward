import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { releaseExpiredCoinReservations } from "../services/coins.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "NO_SHOP_SESSION" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  const cartToken = String(url.searchParams.get("cartToken") || "");
  const reservationId = String(url.searchParams.get("reservationId") || "");
  if (!customerId) return json({ error: "CUSTOMER_NOT_LOGGED_IN" }, 401);
  if (!cartToken && !reservationId) return json({ error: "CART_TOKEN_REQUIRED" }, 400);

  const shop = session.shop;
  const customer = String(customerId);

  try {
    await releaseExpiredCoinReservations({ shop, customerId: customer });
    const reservation = await prisma.coinReservation.findUnique({
      where: reservationId
        ? { id: reservationId }
        : { shop_cartToken: { shop, cartToken } },
      select: { shop: true, customerId: true, coins: true, status: true, expiresAt: true },
    });

    if (
      !reservation ||
      reservation.shop !== shop ||
      reservation.customerId !== customer ||
      reservation.status !== "ACTIVE" ||
      reservation.expiresAt <= new Date()
    ) {
      return json({ status: "NONE", reservedCoins: 0 });
    }
    return json({ status: "ACTIVE", reservedCoins: reservation.coins });
  } catch (error) {
    console.error("[coin-reserve] status failed", { shop, customerId: customer, cartToken, error });
    return json({ error: "COIN_RESERVATION_STATUS_FAILED" }, 500);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
