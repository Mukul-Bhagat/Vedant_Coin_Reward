import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  console.log("[coin-order] fulfillment-order cancellation does not award reward coins", {
    shop,
  });

  return new Response();
};
