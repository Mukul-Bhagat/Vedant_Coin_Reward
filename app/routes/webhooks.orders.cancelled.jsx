import { authenticate } from "../shopify.server";
import { reverseOrderCoinTransactions } from "../services/coins.server";

export const action = async ({ request }) => {
  const { payload, shop, topic, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !payload?.id || !payload.customer?.id) {
    return new Response();
  }

  await reverseOrderCoinTransactions({
    shop,
    orderId: payload.id,
    eventKey: `order-cancelled:${payload.id}`,
    description: `Coins reversed for cancelled order ${payload.name || payload.id}`,
  });

  return new Response();
};
