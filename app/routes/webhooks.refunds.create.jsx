import { authenticate } from "../shopify.server";
import {
  calculateRefundRatio,
  reverseOrderCoinTransactions,
} from "../services/coins.server";

export const action = async ({ request }) => {
  const { payload, shop, topic, admin, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderId = payload?.order_id;
  if (!session || !admin || !orderId) {
    return new Response();
  }

  const refundItems = Array.isArray(payload.refund_line_items)
    ? payload.refund_line_items
    : [];

  if (refundItems.length === 0) {
    return new Response();
  }

  const response = await admin.graphql(
    `#graphql
      query RefundOrderSubtotal($id: ID!) {
        order(id: $id) {
          subtotalPriceSet {
            shopMoney {
              amount
            }
          }
        }
      }
    `,
    {
      variables: {
        id: `gid://shopify/Order/${orderId}`,
      },
    },
  );
  const responseJson = await response.json();
  const orderSubtotal = Number(
    responseJson.data?.order?.subtotalPriceSet?.shopMoney?.amount || 0,
  );

  const refundedAmount = refundItems.reduce((total, item) => {
    const subtotal = Number(
      item.subtotal ??
        Number(item.line_item?.price || 0) * Number(item.quantity || 0),
    );
    return total + (Number.isFinite(subtotal) ? subtotal : 0);
  }, 0);

  const refundRatio = calculateRefundRatio({
    refundedAmount,
    orderSubtotal,
  });

  const lineItemQuantities = refundItems.reduce((quantities, item) => {
    const lineItemId = String(item.line_item_id || item.line_item?.id || "").trim();
    const quantity = Math.floor(Number(item.quantity));

    if (lineItemId && Number.isFinite(quantity) && quantity > 0) {
      quantities[lineItemId] = (quantities[lineItemId] || 0) + quantity;
    }

    return quantities;
  }, {});

  if (refundRatio <= 0 && Object.keys(lineItemQuantities).length === 0) {
    return new Response();
  }

  await reverseOrderCoinTransactions({
    shop,
    orderId,
    eventKey: `refund:${payload.id}`,
    refundRatio,
    lineItemQuantities,
    description: `Coins reversed for refund ${payload.id}`,
  });

  return new Response();
};
