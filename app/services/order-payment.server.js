import prisma from "../db.server.js";

const PAYMENT_CONFIGURATION_NAMESPACE = "$app:payment-customization";
const PAYMENT_CONFIGURATION_KEY = "function-configuration";

export const PaymentRewardMode = Object.freeze({
  ONLINE: "ONLINE",
  MANUAL: "MANUAL",
});

// Kept for the existing COD redemption flow. It is not used to decide rewards.
export function isCashOnDeliveryOrder(order) {
  const gateways = [
    order?.gateway,
    ...(Array.isArray(order?.payment_gateway_names)
      ? order.payment_gateway_names
      : []),
  ]
    .filter(Boolean)
    .map((gateway) => String(gateway).trim().toLowerCase());

  return gateways.some(
    (gateway) => gateway.includes("cash on delivery") || /\bcod\b/.test(gateway),
  );
}

/**
 * The existing payment customization is the source of truth: ONLINE keeps
 * online methods visible, while COD/MANUAL/OFF makes payment an offline
 * workflow. Gateway labels and `financial_status` are intentionally ignored.
 */
export function getPaymentRewardModeFromConfiguration(value) {
  if (!value) {
    return PaymentRewardMode.ONLINE;
  }

  try {
    const paymentMode = String(JSON.parse(value)?.paymentMode || "ONLINE")
      .trim()
      .toUpperCase();

    return ["COD", "MANUAL", "OFF"].includes(paymentMode)
      ? PaymentRewardMode.MANUAL
      : PaymentRewardMode.ONLINE;
  } catch {
    // The checkout function also defaults invalid configuration to ONLINE.
    return PaymentRewardMode.ONLINE;
  }
}

export async function getStorePaymentRewardMode(admin) {
  if (!admin?.graphql) {
    throw new Error("Shopify Admin GraphQL client is required");
  }

  const response = await admin.graphql(
    `#graphql
      query CoinRewardPaymentMode {
        paymentCustomizations(first: 250) {
          nodes {
            enabled
            metafield(
              namespace: "${PAYMENT_CONFIGURATION_NAMESPACE}"
              key: "${PAYMENT_CONFIGURATION_KEY}"
            ) {
              value
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
  );
  const responseJson = await response.json();

  if (responseJson.errors?.length) {
    console.error(
      "Failed to read payment reward mode configuration:",
      responseJson.errors,
    );
    throw new Error("Shopify payment reward mode query failed");
  }

  const paymentCustomizations = responseJson.data?.paymentCustomizations;
  if (paymentCustomizations?.pageInfo?.hasNextPage) {
    throw new Error("Payment customization state is incomplete");
  }

  return getPaymentRewardModeFromCustomizations(paymentCustomizations?.nodes);
}

export function getPaymentRewardModeFromCustomizations(paymentCustomizations) {
  const enabledCustomization = (paymentCustomizations || []).find(
    (customization) => customization?.enabled,
  );

  // Without an enabled instance of this app's payment customization, there is
  // no store-level proof that a paid webhook represents online payment. Fail
  // closed to the fulfillment-resolution path instead of guessing by gateway.
  if (!enabledCustomization) {
    return PaymentRewardMode.MANUAL;
  }

  return getPaymentRewardModeFromConfiguration(
    enabledCustomization.metafield?.value,
  );
}

export function isOnlinePaymentRewardMode(mode) {
  return mode === PaymentRewardMode.ONLINE;
}

export function getOrderRewardModeTransactionKey({ shop, orderId }) {
  const normalizedShop = String(shop || "").trim();
  const normalizedOrderId = String(orderId || "").trim();

  if (!normalizedShop || !normalizedOrderId) {
    throw new Error("shop and orderId are required");
  }

  return `order-reward-mode:${normalizedShop}:${normalizedOrderId}`;
}

/**
 * Snapshot the store mode at order creation in the existing immutable ledger.
 * This is a zero-coin ADJUSTMENT, never a customer reward or balance change.
 * It prevents a later merchant configuration change from reclassifying an
 * already-created manual order as an online-payment order (or vice versa).
 */
export async function recordOrderRewardMode({
  shop,
  customerId,
  orderId,
  orderName = null,
  mode,
}) {
  if (!shop || !customerId || !orderId) {
    throw new Error("shop, customerId, and orderId are required");
  }

  const normalizedMode = normalizePaymentRewardMode(mode);
  const transactionKey = getOrderRewardModeTransactionKey({ shop, orderId });

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.coinTransaction.findUnique({
        where: { transactionKey },
      });
      if (existing) {
        return { mode: getModeFromLedgerDescription(existing.description), duplicate: true };
      }

      const balance = await tx.customerCoinBalance.upsert({
        where: {
          shop_customerId: {
            shop,
            customerId: String(customerId),
          },
        },
        update: {},
        create: {
          shop,
          customerId: String(customerId),
          availableCoins: 0,
          reservedCoins: 0,
        },
      });

      await tx.coinTransaction.create({
        data: {
          shop,
          customerId: String(customerId),
          type: "ADJUSTMENT",
          coins: 0,
          balanceAfter: balance.availableCoins,
          orderId: String(orderId),
          orderName,
          transactionKey,
          status: "COMPLETED",
          description: getOrderRewardModeLedgerDescription(normalizedMode),
        },
      });

      return { mode: normalizedMode, duplicate: false };
    });
  } catch (error) {
    // Concurrent duplicate webhooks can race before either transaction sees
    // the marker. The unique transaction key remains the final authority.
    if (error?.code !== "P2002") {
      throw error;
    }

    const existing = await prisma.coinTransaction.findUnique({
      where: { transactionKey },
    });

    if (!existing) {
      throw error;
    }

    return { mode: getModeFromLedgerDescription(existing.description), duplicate: true };
  }
}

export async function getOrderRewardMode({
  admin,
  shop,
  customerId,
  orderId,
  orderName = null,
}) {
  const transactionKey = getOrderRewardModeTransactionKey({ shop, orderId });
  const existing = await prisma.coinTransaction.findUnique({
    where: { transactionKey },
    select: { description: true },
  });

  if (existing) {
    return getModeFromLedgerDescription(existing.description);
  }

  const mode = await getStorePaymentRewardMode(admin);
  const recorded = await recordOrderRewardMode({
    shop,
    customerId,
    orderId,
    orderName,
    mode,
  });

  return recorded.mode;
}

function normalizePaymentRewardMode(mode) {
  return mode === PaymentRewardMode.MANUAL
    ? PaymentRewardMode.MANUAL
    : PaymentRewardMode.ONLINE;
}

function getOrderRewardModeLedgerDescription(mode) {
  return `Reward payment mode snapshot: ${mode}`;
}

function getModeFromLedgerDescription(description) {
  return String(description || "").endsWith(PaymentRewardMode.MANUAL)
    ? PaymentRewardMode.MANUAL
    : PaymentRewardMode.ONLINE;
}
