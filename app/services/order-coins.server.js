import { creditCoins } from "./coins.server.js";

const REWARD_NAMESPACE = "custom";
const REWARD_KEY = "reward_coins_earned";
const TERMINAL_FULFILLMENT_ORDER_STATUSES = new Set([
  "CANCELLED",
  "CLOSED",
  "INCOMPLETE",
]);

/**
 * A line reward has one identity regardless of which webhook reaches it.
 * Paid and fulfillment-resolution paths therefore cannot create separate
 * credits for the same order line.
 */
export function getOrderRewardTransactionKey({
  shop,
  orderId,
  lineItemId,
  lineIndex,
}) {
  const normalizedShop = String(shop || "").trim();
  const order = String(orderId || "").trim();
  const item = String(lineItemId || "").trim();
  const index = Number(lineIndex);

  if (!normalizedShop) {
    throw new Error("shop is required");
  }
  if (!order) {
    throw new Error("orderId is required");
  }

  if (item) {
    return `order-reward:${normalizedShop}:${order}:line:${item}`;
  }

  if (!Number.isInteger(index) || index < 0) {
    throw new Error("lineItemId or a non-negative lineIndex is required");
  }

  return `order-reward:${normalizedShop}:${order}:line-index:${index}`;
}

export function calculateOrderRewardCredits({
  lineItems,
  rewardByProductId,
}) {
  if (!Array.isArray(lineItems)) {
    return [];
  }

  return lineItems.flatMap((lineItem, index) => {
    const productId = lineItem?.product_id;
    const reward = rewardByProductId.get(
      `gid://shopify/Product/${productId}`,
    ) ?? rewardByProductId.get(String(productId));
    const quantity = Math.max(0, Math.floor(Number(lineItem?.quantity) || 0));
    const rewardCoins = Math.max(
      0,
      Math.floor(Number(reward?.rewardCoins) || 0),
    );

    if (!productId || quantity <= 0 || rewardCoins <= 0) {
      return [];
    }

    return [{
      index,
      lineItem,
      productId: String(productId),
      productTitle: reward.title || lineItem.title || null,
      quantity,
      coins: rewardCoins * quantity,
    }];
  });
}

/**
 * The order is final only when Shopify says it is no longer fulfillable and
 * every visible fulfillment order is in a terminal state. This deliberately
 * rejects a partially fulfilled order with remaining actionable quantity.
 */
export function isOrderFulfillmentResolutionComplete(order) {
  if (!order || order.fulfillable) {
    return false;
  }

  const fulfillmentOrders = order.fulfillmentOrders;
  if (!fulfillmentOrders || fulfillmentOrders.pageInfo?.hasNextPage) {
    return false;
  }

  return (fulfillmentOrders.nodes || []).every((fulfillmentOrder) => {
    if (fulfillmentOrder?.lineItems?.pageInfo?.hasNextPage) {
      return false;
    }

    return TERMINAL_FULFILLMENT_ORDER_STATUSES.has(
      String(fulfillmentOrder?.status || "").toUpperCase(),
    );
  });
}

/**
 * Converts authoritative Admin GraphQL fulfillment/refund data into the
 * existing reward calculator shape. Successful fulfillment quantities earn
 * rewards; quantities already refunded before finalization do not.
 */
export function getRewardEligibleLineItems(order) {
  if (!order || !isOrderFulfillmentResolutionComplete(order)) {
    return [];
  }

  const fulfilledQuantities = new Map();
  for (const fulfillment of order.fulfillments || []) {
    if (String(fulfillment?.status || "").toUpperCase() !== "SUCCESS") {
      continue;
    }

    if (fulfillment?.fulfillmentLineItems?.pageInfo?.hasNextPage) {
      return [];
    }

    for (const fulfillmentLineItem of fulfillment?.fulfillmentLineItems?.nodes || []) {
      const lineItemId = getLegacyId(fulfillmentLineItem?.lineItem);
      const quantity = toPositiveInteger(fulfillmentLineItem?.quantity);

      if (lineItemId && quantity > 0) {
        fulfilledQuantities.set(
          lineItemId,
          (fulfilledQuantities.get(lineItemId) || 0) + quantity,
        );
      }
    }
  }

  const refundedQuantities = getRefundedLineItemQuantities(order);

  return (order.lineItems?.nodes || []).flatMap((lineItem) => {
    const lineItemId = getLegacyId(lineItem);
    const fulfilledQuantity = fulfilledQuantities.get(lineItemId) || 0;
    const refundedQuantity = refundedQuantities.get(lineItemId) || 0;
    const originalQuantity = toPositiveInteger(lineItem?.quantity);
    const eligibleQuantity = Math.max(
      0,
      Math.min(originalQuantity, fulfilledQuantity - refundedQuantity),
    );
    const productId = getLegacyId(lineItem?.product);

    if (!lineItemId || !productId || eligibleQuantity <= 0) {
      return [];
    }

    return [{
      id: lineItemId,
      product_id: productId,
      quantity: eligibleQuantity,
      title: lineItem.title || null,
    }];
  });
}

export function getRefundedLineItemQuantities(order) {
  const refundedQuantities = new Map();

  for (const refund of order?.refunds || []) {
    if (refund?.refundLineItems?.pageInfo?.hasNextPage) {
      return new Map();
    }

    for (const refundLineItem of refund?.refundLineItems?.nodes || []) {
      const lineItemId = getLegacyId(refundLineItem?.lineItem);
      const quantity = toPositiveInteger(refundLineItem?.quantity);

      if (lineItemId && quantity > 0) {
        refundedQuantities.set(
          lineItemId,
          (refundedQuantities.get(lineItemId) || 0) + quantity,
        );
      }
    }
  }

  return refundedQuantities;
}

export async function awardOrderRewardCoins({
  admin,
  shop,
  customerId,
  order,
  getTransactionKey = getOrderRewardTransactionKey,
  credit = creditCoins,
}) {
  if (!admin?.graphql) {
    throw new Error("Shopify Admin GraphQL client is required");
  }

  if (!shop || !customerId || !order?.id || typeof getTransactionKey !== "function") {
    throw new Error("shop, customerId, order.id, and getTransactionKey are required");
  }

  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (lineItems.length === 0) {
    return { rewardCredits: [], creditResults: [] };
  }

  const productIds = [
    ...new Set(
      lineItems
        .map((item) => item?.product_id)
        .filter(Boolean)
        .map((productId) => `gid://shopify/Product/${productId}`),
    ),
  ];
  if (productIds.length === 0) {
    return { rewardCredits: [], creditResults: [] };
  }

  const response = await admin.graphql(
    `#graphql
      query ProductRewardCoins($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            metafield(namespace: "${REWARD_NAMESPACE}", key: "${REWARD_KEY}") {
              value
            }
          }
        }
      }
    `,
    { variables: { ids: productIds } },
  );
  const responseJson = await response.json();

  if (responseJson.errors?.length) {
    console.error("Failed to read product reward metafields:", responseJson.errors);
    throw new Error("Shopify product reward metafield query failed");
  }

  const rewardByProductId = new Map();
  for (const product of responseJson.data?.nodes || []) {
    if (!product?.id) {
      continue;
    }

    const rewardCoins = Number(product.metafield?.value || 0);
    rewardByProductId.set(product.id, {
      title: product.title || null,
      rewardCoins:
        Number.isFinite(rewardCoins) && rewardCoins > 0
          ? Math.floor(rewardCoins)
          : 0,
    });
  }

  const rewardCredits = calculateOrderRewardCredits({
    lineItems,
    rewardByProductId,
  });
  const creditResults = [];

  for (const rewardCredit of rewardCredits) {
    const item = rewardCredit.lineItem;
    const result = await credit({
      shop,
      customerId: String(customerId),
      coins: rewardCredit.coins,
      transactionKey: getTransactionKey({
        shop,
        orderId: order.id,
        lineItemId: item.id,
        lineIndex: rewardCredit.index,
        rewardedQuantity: rewardCredit.quantity,
      }),
      orderId: String(order.id),
      orderName: order.name || null,
      productId: rewardCredit.productId,
      productTitle: rewardCredit.productTitle,
      lineItemId: item.id,
      rewardQuantity: rewardCredit.quantity,
      description: `Reward coins earned from ${order.name || order.id}`,
    });

    creditResults.push({ rewardCredit, result });
  }

  return { rewardCredits, creditResults };
}

function getLegacyId(resource) {
  const legacyId = String(resource?.legacyResourceId || "").trim();
  if (legacyId) {
    return legacyId;
  }

  const id = String(resource?.id || "").trim();
  const gidMatch = id.match(/^gid:\/\/shopify\/[^/]+\/(.+)$/);
  return gidMatch?.[1] || id;
}

function toPositiveInteger(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}
