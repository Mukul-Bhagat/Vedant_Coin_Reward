import { authenticate } from "../shopify.server";
import {
  creditCoins,
  commitCoinReservation,
} from "../services/coins.server";
import {
  calculateOrderRewardCredits,
  getPaidOrderRewardTransactionKey,
} from "../services/order-coins.server";

const REWARD_NAMESPACE = "custom";
const REWARD_KEY = "reward_coins_earned";

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
    console.log(
      `Skipping ${topic}: no active Shopify session.`,
    );

    return new Response();
  }

  const order = payload;

  if (!order?.id) {
    console.log(
      `Skipping ${topic}: order ID is missing.`,
    );

    return new Response();
  }

  const customerId = order.customer?.id;

  if (!customerId) {
    console.log(
      `Skipping paid order ${order.name || order.id}: no customer account.`,
    );

    return new Response();
  }

  /*
   * ---------------------------------------------------------
   * STEP 1
   * Commit any Coin reservation belonging to this cart.
   * ---------------------------------------------------------
   */

  const cartToken = String(
    order.cart_token || "",
  ).trim();

  if (cartToken) {
    try {
      const commitResult = await commitCoinReservation({
        shop,
        customerId: String(customerId),
        cartToken,
        orderId: String(order.id),
        orderName: order.name || null,
        description: `Coins redeemed on paid order ${order.name || order.id}`,
      });

      console.log("[coin-order] paid reservation processed", {
        shop,
        customerId: String(customerId),
        orderId: String(order.id),
        orderName: order.name || null,
        cartToken,
        reservationId: commitResult.reservation?.id || null,
        duplicate: commitResult.duplicate,
        committed: !commitResult.notFound,
      });
    } catch (error) {
      console.error(
        `Failed to commit coin reservation for order ${order.name || order.id}:`,
        error,
      );
      throw error;
    }
  } else {
    console.log(
      `Paid order ${order.name || order.id} has no cart_token; no coin reservation can be matched.`,
    );
  }

  /*
   * ---------------------------------------------------------
   * STEP 2
   * Award product reward coins.
   *
   * This happens only after the order is paid.
   * ---------------------------------------------------------
   */

  const lineItems = Array.isArray(
    order.line_items,
  )
    ? order.line_items
    : [];

  if (lineItems.length === 0) {
    console.log(
      `Skipping reward processing for ${order.name || order.id}: no line items.`,
    );

    return new Response();
  }

  const productIds = [
    ...new Set(
      lineItems
        .map(
          (item) => item?.product_id,
        )
        .filter(Boolean)
        .map(
          (productId) =>
            `gid://shopify/Product/${productId}`,
        ),
    ),
  ];

  if (productIds.length === 0) {
    console.log(
      `Skipping reward processing for ${order.name || order.id}: no product IDs.`,
    );

    return new Response();
  }

  const response =
    await admin.graphql(
      `#graphql
      query ProductRewardCoins($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            metafield(
              namespace: "${REWARD_NAMESPACE}"
              key: "${REWARD_KEY}"
            ) {
              value
            }
          }
        }
      }
      `,
      {
        variables: {
          ids: productIds,
        },
      },
    );

  const responseJson =
    await response.json();

  if (responseJson.errors?.length) {
    console.error(
      "Failed to read product reward metafields:",
      responseJson.errors,
    );

    throw new Error(
      "Shopify product reward metafield query failed",
    );
  }

  const products =
    responseJson.data?.nodes || [];

  const rewardByProductId =
    new Map();

  for (const product of products) {
    if (!product?.id) {
      continue;
    }

    const rewardCoins = Number(
      product.metafield?.value || 0,
    );

    rewardByProductId.set(
      product.id,
      {
        title:
          product.title || null,
        rewardCoins:
          Number.isFinite(
            rewardCoins,
          ) &&
          rewardCoins > 0
            ? Math.floor(
                rewardCoins,
              )
            : 0,
      },
    );
  }

  const rewardCredits = calculateOrderRewardCredits({
    lineItems,
    rewardByProductId,
  });

  for (const rewardCredit of rewardCredits) {
    const item = rewardCredit.lineItem;
    const totalCoins = rewardCredit.coins;

    await creditCoins({
      shop,
      customerId:
        String(customerId),
      coins: totalCoins,
      transactionKey: getPaidOrderRewardTransactionKey({
        orderId: order.id,
        lineItemId: item.id,
        lineIndex: rewardCredit.index,
      }),
      orderId:
        String(order.id),
      orderName:
        order.name || null,
      productId:
        rewardCredit.productId,
      productTitle:
        rewardCredit.productTitle,
      description:
        `Reward coins earned from ${order.name || order.id}`,
    });

    console.log(
      `Credited ${totalCoins} coins for ${rewardCredit.productTitle || item.product_id} to customer ${customerId}.`,
    );
  }

  return new Response();
};
