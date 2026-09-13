import { authenticate } from "../shopify.server";
import {
  getOrderIdFromFulfillmentOrder,
  processManualOrderFulfillmentReward,
} from "../services/order-reward-processing.server";

export const action = async ({ request }) => {
  const { payload, shop, topic, admin, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const fulfillmentOrderId = String(
    payload?.fulfillment_order?.id || payload?.id || "",
  ).trim();
  if (!session || !admin || !fulfillmentOrderId) {
    return new Response();
  }

  const orderId = await getOrderIdFromFulfillmentOrder(admin, fulfillmentOrderId);
  if (!orderId) {
    return new Response();
  }

  const result = await processManualOrderFulfillmentReward({
    admin,
    shop,
    orderId,
  });

  console.log("[coin-order] fulfillment-order cancellation reward processed", {
    shop,
    orderId,
    skipped: result.skipped,
    credits: result.creditResults.length,
  });

  return new Response();
};
