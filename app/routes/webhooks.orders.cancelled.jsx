import { authenticate } from "../shopify.server";
import {
  releaseCommittedCoinReservation,
  reverseOrderCoinTransactions,
} from "../services/coins.server";
import { getRefundedLineItemQuantities } from "../services/order-coins.server";
import { getOrderRewardState } from "../services/order-reward-processing.server";

export const action = async ({ request }) => {
  const { payload, shop, topic, admin, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin || !payload?.id) {
    return new Response();
  }

  const order = await getOrderRewardState(admin, payload.id);
  const lineItemQuantities = Object.fromEntries(
    getRefundedLineItemQuantities(order),
  );

  await releaseCommittedCoinReservation({
    shop,
    orderId: String(payload.id),
    description: `Coins restored for cancelled order ${payload.name || payload.id}`,
  });

  await reverseOrderCoinTransactions({
    shop,
    orderId: payload.id,
    eventKey: `order-cancelled:${payload.id}`,
    lineItemQuantities,
    description: `Coins reversed for cancelled order ${payload.name || payload.id}`,
  });

  return new Response();
};
