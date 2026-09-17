import { authenticate } from "../shopify.server";
import {
  releaseCommittedCoinReservation,
  reverseOrderCoinTransactions,
} from "../services/coins.server";
import { getRefundedLineItemQuantities } from "../services/order-coins.server";
import {
  getOrderRewardState,
  processManualOrderFulfillmentReward,
} from "../services/order-reward-processing.server";

export const action = async ({ request }) => {
  const { payload, shop, topic, admin, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin || !payload?.id) {
    return new Response();
  }

  // A cancellation can be the terminal event for an order with some fulfilled
  // and some removed quantities. Finalize those fulfilled lines before the
  // cancellation reconciliation. The reconciliation intentionally leaves new
  // line rewards alone unless a refunds/create webhook names the line/quantity.
  await processManualOrderFulfillmentReward({
    admin,
    shop,
    orderId: payload.id,
  });

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
