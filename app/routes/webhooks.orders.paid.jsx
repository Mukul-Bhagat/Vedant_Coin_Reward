import { authenticate } from "../shopify.server";
import {
  awardOrderRewardCoins,
  getOrderRewardTransactionKey,
} from "../services/order-coins.server";

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
