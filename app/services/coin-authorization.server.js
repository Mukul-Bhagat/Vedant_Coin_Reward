import prisma from "../db.server.js";
import { releaseExpiredCoinReservations } from "./coins.server.js";

export async function authorizeCoinDiscount({
  shop,
  customerId,
  cartToken,
  requestedCoins,
  merchandiseSubtotal,
  now = new Date(),
}) {
  if (!shop || !customerId || !cartToken) {
    return { authorized: false, reason: "missing_identity" };
  }

  const coins = Math.floor(Number(requestedCoins));
  const subtotal = Number(merchandiseSubtotal);

  if (
    !Number.isFinite(coins) ||
    coins <= 0 ||
    !Number.isFinite(subtotal) ||
    subtotal <= 0 ||
    coins > Math.floor(subtotal)
  ) {
    return { authorized: false, reason: "invalid_amount" };
  }

  await releaseExpiredCoinReservations({
    shop,
    customerId,
    now,
  });

  const reservation = await prisma.coinReservation.findUnique({
    where: {
      shop_cartToken: {
        shop,
        cartToken,
      },
    },
    select: {
      customerId: true,
      coins: true,
      status: true,
      expiresAt: true,
    },
  });

  if (
    !reservation ||
    reservation.customerId !== String(customerId) ||
    reservation.status !== "ACTIVE" ||
    reservation.expiresAt <= now ||
    reservation.coins !== coins
  ) {
    return { authorized: false, reason: "reservation_mismatch" };
  }

  return {
    authorized: true,
    coins,
  };
}
