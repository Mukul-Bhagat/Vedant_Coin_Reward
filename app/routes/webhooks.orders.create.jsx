import { authenticate } from "../shopify.server";
import { commitCoinReservation } from "../services/coins.server";
import { isCashOnDeliveryOrder } from "../services/order-payment.server";

export const action = async ({ request }) => {
  const { payload, shop, topic, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload;
  const customerId = order?.customer?.id;

  if (!session || !order?.id || !customerId || !isCashOnDeliveryOrder(order)) {
    return new Response();
  }

  const cartToken = String(order.cart_token || "").trim();
  if (!cartToken) {
    console.log("[coin-cod] order has no cart token", {
      shop,
      orderId: String(order.id),
      orderName: order.name || null,
    });
    return new Response();
  }

  const result = await commitCoinReservation({
    shop,
    customerId: String(customerId),
    cartToken,
    orderId: String(order.id),
    orderName: order.name || null,
    description: `Coins redeemed on COD order ${order.name || order.id}`,
  });

  console.log("[coin-cod] reservation processed", {
    shop,
    customerId: String(customerId),
    orderId: String(order.id),
    orderName: order.name || null,
    cartToken,
    reservationId: result.reservation?.id || null,
    duplicate: result.duplicate,
    committed: !result.notFound,
  });

  return new Response();
};
