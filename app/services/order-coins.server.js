export function getPaidOrderRewardTransactionKey({
  orderId,
  lineItemId,
  lineIndex,
}) {
  const order = String(orderId || "").trim();
  const item = String(lineItemId || "").trim();
  const index = Number(lineIndex);

  if (!order) {
    throw new Error("orderId is required");
  }

  if (item) {
    return `order-paid:${order}:line:${item}`;
  }

  if (!Number.isInteger(index) || index < 0) {
    throw new Error("lineItemId or a non-negative lineIndex is required");
  }

  return `order-paid:${order}:line-index:${index}`;
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
    const quantity = Math.max(0, Number(lineItem?.quantity) || 0);
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
      coins: rewardCoins * quantity,
    }];
  });
}
