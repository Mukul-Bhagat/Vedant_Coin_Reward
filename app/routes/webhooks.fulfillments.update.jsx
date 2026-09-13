import { authenticate } from "../shopify.server";
import { processManualOrderFulfillmentReward } from "../services/order-reward-processing.server";

export const action = async ({ request }) => {
  const { payload, shop, topic, admin, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderId = String(payload?.order_id || "").trim();
  if (!session || !admin || !orderId) {
    return new Response();
  }

  const result = await processManualOrderFulfillmentReward({
    admin,
    shop,
    orderId,
  });

  console.log("[coin-order] fulfillment update reward processed", {
    shop,
    orderId,
    skipped: result.skipped,
    credits: result.creditResults.length,
  });

  return new Response();
};
