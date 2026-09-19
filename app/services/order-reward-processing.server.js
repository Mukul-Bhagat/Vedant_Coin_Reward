const MAX_NODES = 250;

/**
 * Load the current order state rather than treating a webhook payload as the
 * source of truth. Fulfillment orders tell us whether work remains; successful
 * fulfillment line items tell us precisely what was fulfilled.
 */
export async function getOrderRewardState(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
      query CoinRewardOrderState($id: ID!) {
        order(id: $id) {
          legacyResourceId
          name
          cancelledAt
          fulfillable
          customer {
            legacyResourceId
          }
          lineItems(first: ${MAX_NODES}) {
            nodes {
              id
              quantity
              currentQuantity
              unfulfilledQuantity
              title
              product {
                id
                legacyResourceId
              }
            }
            pageInfo {
              hasNextPage
            }
          }
          fulfillmentsCount {
            count
          }
          fulfillments(first: ${MAX_NODES}) {
            status
            fulfillmentLineItems(first: ${MAX_NODES}) {
              nodes {
                quantity
                lineItem {
                  id
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
          fulfillmentOrders(first: ${MAX_NODES}, displayable: false) {
            nodes {
              status
              lineItems(first: ${MAX_NODES}) {
                nodes {
                  remainingQuantity
                  totalQuantity
                }
                pageInfo {
                  hasNextPage
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
          refunds {
            refundLineItems(first: ${MAX_NODES}) {
              nodes {
                quantity
                lineItem {
                  id
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { variables: { id: toOrderGid(orderId) } },
  );
  const responseJson = await response.json();

  if (responseJson.errors?.length) {
    console.error("Failed to read order reward state:", responseJson.errors);
    throw new Error("Shopify order reward state query failed");
  }

  const order = responseJson.data?.order;
  if (!order) {
    return null;
  }

  if (
    order.lineItems?.pageInfo?.hasNextPage ||
    order.fulfillmentOrders?.pageInfo?.hasNextPage ||
    Number(order.fulfillmentsCount?.count) > (order.fulfillments || []).length ||
    (order.fulfillments || []).some(
      (fulfillment) => fulfillment?.fulfillmentLineItems?.pageInfo?.hasNextPage,
    ) ||
    (order.refunds || []).some(
      (refund) => refund?.refundLineItems?.pageInfo?.hasNextPage,
    )
  ) {
    throw new Error("Shopify order reward state is incomplete");
  }

  return order;
}

function toOrderGid(orderId) {
  const id = String(orderId || "").trim();
  return id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`;
}
