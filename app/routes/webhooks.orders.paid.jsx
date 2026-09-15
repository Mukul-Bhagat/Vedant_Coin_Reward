import { authenticate } from "../shopify.server";
import { commitCoinReservation } from "../services/coins.server";
import {
  awardOrderRewardCoins,
  getOrderRewardTransactionKey,
} from "../services/order-coins.server";
import {
  getOrderRewardMode,
} from "../services/order-payment.server";

export const action = async ({ request }) => {
  const {
    payload,
    shop,
    topic,
    admin,
    session,
  } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin) {
    console.log(`Skipping ${topic}: no active Shopify session.`);
    return new Response();
  }

  const order = payload;

  if (!order?.id) {
    console.log(`Skipping ${topic}: order ID is missing.`);
    return new Response();
  }

  const customerId = order.customer?.id;

  if (!customerId) {
    console.log(
      `Skipping paid order ${order.name || order.id}: no customer account.`,
    );
    return new Response();
  }

  // Keep redemption handling on orders/paid for every payment type.
  const cartToken = String(order.cart_token || "").trim();

  if (cartToken) {
    try {
      const commitResult = await commitCoinReservation({
        shop,
        customerId: String(customerId),
        cartToken,
        orderId: String(order.id),
        orderName: order.name || null,
        description: `Coins redeemed on paid order ${order.name || order.id}`,
      });

      console.log("[coin-order] paid reservation processed", {
        shop,
        customerId: String(customerId),
        orderId: String(order.id),
        orderName: order.name || null,
        cartToken,
        reservationId: commitResult.reservation?.id || null,
        duplicate: commitResult.duplicate,
        committed: !commitResult.notFound,
      });
    } catch (error) {
      console.error(
        `Failed to commit coin reservation for order ${order.name || order.id}:`,
        error,
      );
      throw error;
    }
  } else {
    console.log(
      `Paid order ${order.name || order.id} has no cart_token; no coin reservation can be matched.`,
    );
  }

  // `orders/paid` is an online reward trigger only when the store's existing
  // payment customization is in ONLINE mode. Financial status and gateway
  // labels are not reliable evidence of an online payment.
  await getOrderRewardMode({
    admin,
    shop,
    customerId: String(customerId),
    orderId: String(order.id),
    orderName: order.name || null,
  });
  const { creditResults } = await awardOrderRewardCoins({
    admin,
    shop,
    customerId,
    order,
    getTransactionKey: getOrderRewardTransactionKey,
  });

  for (const { rewardCredit, result } of creditResults) {
    console.log("[coin-order] paid reward processed", {
      shop,
      customerId: String(customerId),
      orderId: String(order.id),
      productId: rewardCredit.productId,
      coins: rewardCredit.coins,
      duplicate: result.duplicate,
    });
  }

  return new Response();
};
