import prisma from "../db.server.js";

/**
 * Get the customer's current available coin balance.
 *
 * Reserved coins are not included because they are temporarily
 * unavailable while another checkout is in progress.
 */
export async function getCoinBalance(shop, customerId) {
  if (!shop || !customerId) {
    throw new Error("shop and customerId are required");
  }

  await releaseExpiredCoinReservations({
    shop,
    customerId: String(customerId),
  });

  const balance = await prisma.customerCoinBalance.findUnique({
    where: {
      shop_customerId: {
        shop,
        customerId: String(customerId),
      },
    },
    select: {
      availableCoins: true,
    },
  });

  return balance?.availableCoins ?? 0;
}

/**
 * Release active reservations that have passed their expiry time.
 * A scheduler or another coin request can call this safely because the
 * ledger transition is idempotent.
 */
export async function releaseExpiredCoinReservations({
  shop,
  customerId = null,
  now = new Date(),
}) {
  if (!shop) {
    throw new Error("shop is required");
  }

  const reservations = await prisma.coinReservation.findMany({
    where: {
      shop,
      ...(customerId ? { customerId: String(customerId) } : {}),
      status: "ACTIVE",
      expiresAt: {
        lte: now,
      },
    },
  });

  let released = 0;

  for (const reservation of reservations) {
    const result = await releaseCoinReservation({
      shop,
      customerId: reservation.customerId,
      reservationId: reservation.id,
      description: "Expired coin reservation released",
    });

    if (!result.duplicate) {
      released += 1;
    }
  }

  return { released };
}

/**
 * Calculate how many coins a customer can redeem.
 *
 * Rules:
 * - Never more than available balance.
 * - Never more than the eligible order amount.
 *
 * 1 coin = ₹1.
 */
export function calculateRedeemableCoins({
  availableCoins,
  orderAmount,
}) {
  const balance = Math.max(0, Number(availableCoins) || 0);
  const amount = Math.max(0, Number(orderAmount) || 0);

  return Math.min(
    balance,
    Math.floor(amount),
  );
}

export function calculateRefundRatio({
  refundedAmount,
  orderSubtotal,
}) {
  const refund = Math.max(0, Number(refundedAmount) || 0);
  const subtotal = Math.max(0, Number(orderSubtotal) || 0);

  if (refund <= 0 || subtotal <= 0) {
    return 0;
  }

  return Math.min(1, refund / subtotal);
}

/**
 * Credit coins to a customer.
 *
 * transactionKey MUST uniquely identify the event being processed.
 * This prevents duplicate webhook/event processing.
 */
export async function creditCoins({
  shop,
  customerId,
  coins,
  transactionKey,
  orderId = null,
  orderName = null,
  productId = null,
  productTitle = null,
  lineItemId = null,
  rewardQuantity = null,
  description = null,
  expiresAt = null,
}) {
  if (!shop || !customerId) {
    throw new Error("shop and customerId are required");
  }

  const amount = Math.floor(Number(coins));

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Coins to credit must be greater than zero");
  }

  if (!transactionKey) {
    throw new Error("transactionKey is required");
  }

  const normalizedRewardQuantity =
    rewardQuantity === null || rewardQuantity === undefined
      ? null
      : Math.floor(Number(rewardQuantity));

  if (
    normalizedRewardQuantity !== null &&
    (!Number.isFinite(normalizedRewardQuantity) || normalizedRewardQuantity <= 0)
  ) {
    throw new Error("rewardQuantity must be a positive integer when provided");
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.coinTransaction.findUnique({
      where: {
        transactionKey,
      },
    });

    if (existing) {
      return {
        transaction: existing,
        balance: existing.balanceAfter,
        duplicate: true,
      };
    }

    const existingBalance =
      await tx.customerCoinBalance.findUnique({
        where: {
          shop_customerId: {
            shop,
            customerId: String(customerId),
          },
        },
      });

    const currentBalance =
      existingBalance?.availableCoins ?? 0;

    const newBalance = currentBalance + amount;

    const balanceRecord =
      existingBalance
        ? await tx.customerCoinBalance.update({
            where: {
              shop_customerId: {
                shop,
                customerId: String(customerId),
              },
            },
            data: {
              availableCoins: newBalance,
            },
          })
        : await tx.customerCoinBalance.create({
            data: {
              shop,
              customerId: String(customerId),
              availableCoins: newBalance,
              reservedCoins: 0,
            },
          });

    const transaction =
      await tx.coinTransaction.create({
        data: {
          shop,
          customerId: String(customerId),
          type: "CREDIT",
          coins: amount,
          balanceAfter: newBalance,
          orderId,
          orderName,
          productId,
          productTitle,
          lineItemId: lineItemId ? String(lineItemId) : null,
          rewardQuantity: normalizedRewardQuantity,
          transactionKey,
          status: "COMPLETED",
          description,
          expiresAt,
        },
      });

    return {
      transaction,
      balance: balanceRecord.availableCoins,
      duplicate: false,
    };
  });
}

/**
 * Reserve coins for a checkout.
 *
 * IMPORTANT:
 * This does NOT permanently remove coins.
 *
 * availableCoins decreases and reservedCoins increases.
 *
 * There is NO per-order coin limit.
 *
 * The caller is responsible for making sure the requested amount
 * does not exceed the cart/order value.
 */
export async function reserveCoins({
  shop,
  customerId,
  cartToken,
  cartFingerprint = null,
  requestedCoins,
  orderId = null,
  orderName = null,
  description = null,
  expiresAt = new Date(Date.now() + 10 * 60 * 1000),
}) {
  if (!shop || !customerId || !cartToken) {
    throw new Error("shop, customerId, and cartToken are required");
  }

  const requested = Math.floor(Number(requestedCoins));

  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error("Requested coins must be greater than zero");
  }

  // Restore expired holds before checking the customer's spendable balance.
  await releaseExpiredCoinReservations({
    shop,
    customerId: String(customerId),
  });

  return prisma.$transaction(async (tx) => {
    const existingReservation = await tx.coinReservation.findUnique({
      where: { shop_cartToken: { shop, cartToken } },
    });

    if (existingReservation?.customerId !== undefined &&
        existingReservation.customerId !== String(customerId)) {
      throw new Error("Cart reservation belongs to another customer");
    }

    if (existingReservation?.status === "COMPLETED") {
      throw new Error("Coin reservation has already been completed");
    }

    if (
      existingReservation?.status === "ACTIVE" &&
      existingReservation.expiresAt > new Date() &&
      existingReservation.coins === requested &&
      existingReservation.cartFingerprint === cartFingerprint
    ) {
      console.log("[coin-reserve] duplicate", {
        shop,
        customerId: String(customerId),
        cartToken,
        reservationId: existingReservation.id,
        coins: requested,
      });
      return { reservation: existingReservation, duplicate: true };
    }

    const balanceRecord =
      await tx.customerCoinBalance.findUnique({
        where: {
          shop_customerId: {
            shop,
            customerId: String(customerId),
          },
        },
      });

    if (!balanceRecord) {
      throw new Error("Customer has no coin balance");
    }

    if (existingReservation?.status === "ACTIVE") {
      const oldTransaction = await tx.coinTransaction.findUnique({
        where: { transactionKey: `coin-reservation:${existingReservation.id}` },
      });

      if (!oldTransaction || oldTransaction.status !== "PENDING") {
        throw new Error("Existing coin reservation ledger is not pending");
      }

      await tx.customerCoinBalance.update({
        where: { shop_customerId: { shop, customerId: String(customerId) } },
        data: {
          availableCoins: balanceRecord.availableCoins + existingReservation.coins,
          reservedCoins: balanceRecord.reservedCoins - existingReservation.coins,
        },
      });
      await tx.coinTransaction.update({
        where: { id: oldTransaction.id },
        data: { status: "CANCELLED", balanceAfter: balanceRecord.availableCoins + existingReservation.coins },
      });
      await tx.coinReservation.update({
        where: { id: existingReservation.id },
        data: { status: "CANCELLED" },
      });
      await tx.coinReservation.delete({ where: { id: existingReservation.id } });
      balanceRecord.availableCoins += existingReservation.coins;
      balanceRecord.reservedCoins -= existingReservation.coins;
    }

    if (existingReservation?.status === "CANCELLED") {
      await tx.coinReservation.delete({ where: { id: existingReservation.id } });
    }

    if (requested > balanceRecord.availableCoins) {
      throw new Error("Insufficient coin balance");
    }

    const newAvailable =
      balanceRecord.availableCoins - requested;

    const newReserved = balanceRecord.reservedCoins + requested;

    const reservation = await tx.coinReservation.create({
      data: {
        shop,
        customerId: String(customerId),
        cartToken,
        cartFingerprint,
        coins: requested,
        status: "ACTIVE",
        expiresAt,
      },
    });

    await tx.customerCoinBalance.update({
      where: {
        shop_customerId: {
          shop,
          customerId: String(customerId),
        },
      },
      data: {
        availableCoins: newAvailable,
          reservedCoins: newReserved,
      },
    });

    const transaction =
      await tx.coinTransaction.create({
        data: {
          shop,
          customerId: String(customerId),
          type: "DEBIT",
          coins: requested,
          balanceAfter: newAvailable,
          orderId,
          orderName,
          transactionKey: `coin-reservation:${reservation.id}`,
          status: "PENDING",
          description:
            description || "Coins reserved for checkout",
        },
      });

    console.log("[coin-reserve] created", {
      shop,
      customerId: String(customerId),
      cartToken,
      reservationId: reservation.id,
      coins: requested,
    });

    return {
      reservation,
      transaction,
      availableCoins: newAvailable,
      reservedCoins: newReserved,
      duplicate: false,
    };
  });
}

// Kept as a compatibility alias for existing internal callers; all behavior lives in reserveCoins.
export const createCoinReservation = reserveCoins;

/**
 * Commit a previously reserved coin redemption.
 *
 * This permanently consumes the reserved coins.
 */
export async function commitCoinReservation({
  shop,
  customerId,
  reservationId = null,
  cartToken = null,
  orderId = null,
  orderName = null,
  transactionKey = null,
  description = null,
}) {
  if (!shop || !customerId) {
    throw new Error("shop and customerId are required");
  }

  reservationId ||= transactionKey?.startsWith("coin-reservation:")
    ? transactionKey.slice("coin-reservation:".length)
    : null;
  if (!reservationId && !cartToken) {
    throw new Error("reservationId or cartToken is required");
  }

  return prisma.$transaction(async (tx) => {
    const reservation = reservationId
      ? await tx.coinReservation.findUnique({ where: { id: reservationId } })
      : await tx.coinReservation.findUnique({
          where: { shop_cartToken: { shop, cartToken } },
        });
    if (!reservation) {
      const balanceRecord = await tx.customerCoinBalance.findUnique({
        where: { shop_customerId: { shop, customerId: String(customerId) } },
        select: { availableCoins: true },
      });
      return {
        balance: balanceRecord?.availableCoins ?? 0,
        duplicate: true,
        notFound: true,
      };
    }
    if (reservation.shop !== shop || reservation.customerId !== String(customerId)) {
      if (reservation.customerId !== String(customerId)) {
        throw new Error("Cart reservation belongs to another customer");
      }
      throw new Error("Coin reservation not found");
    }
    const transaction = await tx.coinTransaction.findUnique({
      where: { transactionKey: `coin-reservation:${reservation.id}` },
    });

    if (!transaction) {
      throw new Error("Coin reservation not found");
    }

    if (transaction.status === "COMPLETED") {
      return {
        reservation,
        transaction,
        duplicate: true,
      };
    }

    if (transaction.status !== "PENDING") {
      throw new Error(
        `Coin reservation cannot be committed from status ${transaction.status}`,
      );
    }

    const balanceRecord =
      await tx.customerCoinBalance.findUnique({
        where: {
          shop_customerId: {
            shop,
            customerId: String(customerId),
          },
        },
      });

    if (!balanceRecord) {
      throw new Error("Customer coin balance not found");
    }

    if (balanceRecord.reservedCoins < transaction.coins) {
      throw new Error("Reserved coin balance is insufficient");
    }

    const updatedBalance =
      await tx.customerCoinBalance.update({
        where: {
          shop_customerId: {
            shop,
            customerId: String(customerId),
          },
        },
        data: {
          reservedCoins:
            balanceRecord.reservedCoins - transaction.coins,
        },
      });

    const updatedTransaction =
      await tx.coinTransaction.update({
        where: {
          id: transaction.id,
        },
        data: {
          status: "COMPLETED",
          orderId: orderId ? String(orderId) : transaction.orderId,
          orderName: orderName || transaction.orderName,
          description:
            description || transaction.description,
          balanceAfter: updatedBalance.availableCoins,
        },
      });

    await tx.coinReservation.updateMany({
      where: { id: reservation.id, status: "ACTIVE" },
      data: { status: "COMPLETED" },
    });

    console.log("[coin-commit] completed", {
      shop,
      customerId: String(customerId),
      reservationId: reservation.id,
      coins: transaction.coins,
    });

    return {
      reservation,
      transaction: updatedTransaction,
      balance: updatedBalance.availableCoins,
      duplicate: false,
    };
  });
}

/**
 * Release a previously reserved coin redemption.
 *
 * Used when checkout fails, is abandoned, cancelled, or otherwise
 * should not consume the customer's coins.
 */
export async function releaseCoinReservation({
  shop,
  customerId,
  reservationId = null,
  cartToken = null,
  transactionKey = null,
  description = null,
}) {
  if (!shop || !customerId) {
    throw new Error("shop and customerId are required");
  }

  reservationId ||= transactionKey?.startsWith("coin-reservation:")
    ? transactionKey.slice("coin-reservation:".length)
    : null;
  if (!reservationId && !cartToken) {
    throw new Error("reservationId or cartToken is required");
  }

  return prisma.$transaction(async (tx) => {
    const reservation = reservationId
      ? await tx.coinReservation.findUnique({ where: { id: reservationId } })
      : await tx.coinReservation.findUnique({
          where: { shop_cartToken: { shop, cartToken } },
        });
    if (!reservation || reservation.shop !== shop || reservation.customerId !== String(customerId)) {
      throw new Error("Coin reservation not found");
    }
    const transaction = await tx.coinTransaction.findUnique({
      where: { transactionKey: `coin-reservation:${reservation.id}` },
    });

    if (!transaction) {
      throw new Error("Coin reservation not found");
    }

    if (transaction.status === "CANCELLED") {
      return {
        transaction,
        duplicate: true,
        released: false,
      };
    }

    if (transaction.status !== "PENDING") {
      throw new Error(
        `Coin reservation cannot be released from status ${transaction.status}`,
      );
    }

    const balanceRecord =
      await tx.customerCoinBalance.findUnique({
        where: {
          shop_customerId: {
            shop,
            customerId: String(customerId),
          },
        },
      });

    if (!balanceRecord) {
      throw new Error("Customer coin balance not found");
    }

    if (balanceRecord.reservedCoins < transaction.coins) {
      throw new Error("Reserved coin balance is insufficient");
    }

    const updatedBalance =
      await tx.customerCoinBalance.update({
        where: {
          shop_customerId: {
            shop,
            customerId: String(customerId),
          },
        },
        data: {
          availableCoins:
            balanceRecord.availableCoins + transaction.coins,
          reservedCoins:
            balanceRecord.reservedCoins - transaction.coins,
        },
      });

    const updatedTransaction =
      await tx.coinTransaction.update({
        where: {
          id: transaction.id,
        },
        data: {
          status: "CANCELLED",
          balanceAfter: updatedBalance.availableCoins,
          description:
            description || "Coin reservation released",
        },
      });

    await tx.coinReservation.updateMany({
      where: { id: reservation.id, status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });

    console.log("[coin-release] completed", {
      shop,
      customerId: String(customerId),
      reservationId: reservation.id,
      coins: transaction.coins,
    });

    return {
      transaction: updatedTransaction,
      balance: updatedBalance.availableCoins,
      duplicate: false,
      released: true,
    };
  });
}

/**
 * Reconcile a reservation against the cart state that is currently visible
 * to the customer. The comparison happens on the server; the browser only
 * supplies the current cart fingerprint and reservation identity.
 */
export async function reconcileCoinReservation({
  shop,
  customerId,
  reservationId = null,
  cartToken = null,
  cartFingerprint,
  description = "Cart changed; coin reservation released",
}) {
  if (!shop || !customerId) {
    throw new Error("shop and customerId are required");
  }
  if (!reservationId && !cartToken) {
    throw new Error("reservationId or cartToken is required");
  }
  if (!cartFingerprint) {
    throw new Error("cartFingerprint is required");
  }

  const reservation = reservationId
    ? await prisma.coinReservation.findUnique({ where: { id: reservationId } })
    : await prisma.coinReservation.findUnique({
        where: { shop_cartToken: { shop, cartToken } },
      });

  if (
    !reservation ||
    reservation.shop !== shop ||
    reservation.customerId !== String(customerId)
  ) {
    throw new Error("Coin reservation not found");
  }

  if (reservation.status !== "ACTIVE") {
    return { reservation, released: false, duplicate: true };
  }

  if (reservation.cartFingerprint === cartFingerprint) {
    return { reservation, released: false, duplicate: false };
  }

  const result = await releaseCoinReservation({
    shop,
    customerId: String(customerId),
    reservationId: reservation.id,
    description,
  });

  console.log("[coin-release] reconciled", {
    shop,
    customerId: String(customerId),
    reservationId: reservation.id,
    cartToken: reservation.cartToken,
    coins: reservation.coins,
    reason: description,
  });

  return {
    ...result,
    reservation,
    released: !result.duplicate,
  };
}

export async function reverseOrderCoinTransactions({
  shop,
  orderId,
  eventKey,
  refundRatio = 1,
  lineItemQuantities = null,
  description = "Order coin reconciliation",
}) {
  if (!shop || !orderId || !eventKey) {
    throw new Error("shop, orderId, and eventKey are required");
  }

  const ratio = Math.min(1, Math.max(0, Number(refundRatio)));
  const refundedQuantities = normalizeLineItemQuantities(lineItemQuantities);

  if (
    (!Number.isFinite(ratio) || ratio <= 0) &&
    refundedQuantities.size === 0
  ) {
    return { reversedCoins: 0, duplicate: false };
  }

  return prisma.$transaction(async (tx) => {
    const originals = await tx.coinTransaction.findMany({
      where: {
        shop,
        orderId: String(orderId),
        status: "COMPLETED",
        type: {
          in: ["CREDIT", "DEBIT"],
        },
      },
    });

    let balanceRecord = null;
    let reversedCoins = 0;

    for (const original of originals) {
      const transactionKey = `${eventKey}:${original.id}`;
      const existing = await tx.coinTransaction.findUnique({
        where: { transactionKey },
      });

      if (existing) {
        continue;
      }

      const isLineReward = original.transactionKey.startsWith("order-reward:");

      // New rewards are never reversed from an order-wide financial ratio.
      // They require the exact Shopify refund line and quantity. This keeps a
      // refund/cancellation of a non-reward product from touching other lines.
      if (isLineReward && refundedQuantities.size === 0) {
        continue;
      }

      const previousReversals = await tx.coinTransaction.findMany({
        where: {
          relatedTransactionId: original.id,
          type: "REVERSAL",
          status: "COMPLETED",
        },
        select: { coins: true, rewardQuantity: true },
      });

      let requestedReversal;
      let reversalQuantity = null;
      let rewardUnitCoins = null;

      if (isLineReward) {
        const lineItemId = String(original.lineItemId || "").trim();
        const originalQuantity = Number(original.rewardQuantity);
        const requestedQuantity = refundedQuantities.get(lineItemId) || 0;

        if (
          !lineItemId ||
          !Number.isInteger(originalQuantity) ||
          originalQuantity <= 0 ||
          requestedQuantity <= 0
        ) {
          continue;
        }

        const unitCoins = original.coins / originalQuantity;
        if (!Number.isInteger(unitCoins) || unitCoins <= 0) {
          throw new Error("Order reward transaction has an invalid reward quantity");
        }
        rewardUnitCoins = unitCoins;

        const alreadyReversedQuantity = previousReversals.reduce(
          (total, transaction) =>
            total +
            (Number.isInteger(transaction.rewardQuantity)
              ? transaction.rewardQuantity
              : Math.ceil(transaction.coins / unitCoins)),
          0,
        );

        reversalQuantity = Math.max(
          0,
          Math.min(requestedQuantity, originalQuantity - alreadyReversedQuantity),
        );
        requestedReversal = reversalQuantity * unitCoins;
      } else {
        const targetCoins = Math.floor(original.coins * ratio);
        const alreadyReversed = previousReversals.reduce(
          (total, transaction) => total + transaction.coins,
          0,
        );
        requestedReversal = Math.max(0, targetCoins - alreadyReversed);
      }

      if (requestedReversal <= 0) {
        continue;
      }

      balanceRecord ||= await tx.customerCoinBalance.findUnique({
        where: {
          shop_customerId: {
            shop,
            customerId: original.customerId,
          },
        },
      });

      if (!balanceRecord) {
        throw new Error("Customer coin balance not found");
      }

      const actualReversal =
        original.type === "CREDIT"
          ? Math.min(requestedReversal, balanceRecord.availableCoins)
          : requestedReversal;

      if (actualReversal <= 0) {
        continue;
      }

      if (isLineReward && actualReversal !== requestedReversal) {
        reversalQuantity =
          actualReversal % rewardUnitCoins === 0
            ? actualReversal / rewardUnitCoins
            : null;
      }

      const availableCoins =
        original.type === "CREDIT"
          ? balanceRecord.availableCoins - actualReversal
          : balanceRecord.availableCoins + actualReversal;

      balanceRecord = await tx.customerCoinBalance.update({
        where: {
          shop_customerId: {
            shop,
            customerId: original.customerId,
          },
        },
        data: {
          availableCoins,
        },
      });

      await tx.coinTransaction.create({
        data: {
          shop,
          customerId: original.customerId,
          type: "REVERSAL",
          coins: actualReversal,
          balanceAfter: availableCoins,
          orderId: original.orderId,
          orderName: original.orderName,
          productId: original.productId,
          productTitle: original.productTitle,
          lineItemId: original.lineItemId,
          rewardQuantity: reversalQuantity,
          transactionKey,
          relatedTransactionId: original.id,
          status: "COMPLETED",
          description,
        },
      });

      reversedCoins += actualReversal;
    }

    return {
      reversedCoins,
      duplicate: originals.length > 0 && reversedCoins === 0,
    };
  });
}

function normalizeLineItemQuantities(lineItemQuantities) {
  const quantities = new Map();
  const entries =
    lineItemQuantities instanceof Map
      ? [...lineItemQuantities.entries()]
      : Array.isArray(lineItemQuantities)
        ? lineItemQuantities
        : Object.entries(lineItemQuantities || {});

  for (const [lineItemId, quantity] of entries) {
    const id = String(lineItemId || "").trim();
    const normalizedQuantity = Math.floor(Number(quantity));

    if (id && Number.isFinite(normalizedQuantity) && normalizedQuantity > 0) {
      quantities.set(id, (quantities.get(id) || 0) + normalizedQuantity);
    }
  }

  return quantities;
}
