import assert from "node:assert/strict";
import test from "node:test";
import {
  awardOrderRewardCoins,
  calculateOrderRewardCredits,
  getOrderRewardTransactionKey,
  getRefundedLineItemQuantities,
  getRewardEligibleLineItems,
  isOrderFulfillmentResolutionComplete,
  normalizeShopifyLegacyId,
} from "./order-coins.server.js";
import {
  getPaymentRewardModeFromCustomizations,
  getPaymentRewardModeFromConfiguration,
  PaymentRewardMode,
} from "./order-payment.server.js";

function resolvedOrder({
  lineItems,
  fulfillments = [],
  refunds = [],
  fulfillmentOrderStatus = "CLOSED",
  fulfillable = false,
} = {}) {
  return {
    fulfillable,
    lineItems: {
      nodes: lineItems.map((lineItem) => ({
        id: `gid://shopify/LineItem/${lineItem.id}`,
        legacyResourceId: lineItem.id,
        quantity: lineItem.quantity,
        currentQuantity: lineItem.quantity,
        unfulfilledQuantity: 0,
        title: lineItem.title,
        product: {
          id: `gid://shopify/Product/${lineItem.productId}`,
          legacyResourceId: lineItem.productId,
        },
      })),
      pageInfo: { hasNextPage: false },
    },
    fulfillments: fulfillments.map((fulfillment) => ({
      status: fulfillment.status || "SUCCESS",
      fulfillmentLineItems: {
        nodes: fulfillment.lines.map((line) => ({
          quantity: line.quantity,
          lineItem: {
            id: `gid://shopify/LineItem/${line.id}`,
            legacyResourceId: line.id,
          },
        })),
        pageInfo: { hasNextPage: false },
      },
    })),
    fulfillmentOrders: {
      nodes: [{
        status: fulfillmentOrderStatus,
        lineItems: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
      }],
      pageInfo: { hasNextPage: false },
    },
    refunds: refunds.map((refund) => ({
      refundLineItems: {
        nodes: refund.lines.map((line) => ({
          quantity: line.quantity,
          lineItem: {
            id: `gid://shopify/LineItem/${line.id}`,
            legacyResourceId: line.id,
          },
        })),
        pageInfo: { hasNextPage: false },
      },
    })),
  };
}

const threeProducts = [
  { id: "a", productId: "product-a", quantity: 1, title: "Product A" },
  { id: "b", productId: "product-b", quantity: 1, title: "Product B" },
  { id: "c", productId: "product-c", quantity: 1, title: "Product C" },
];

test("payment mode comes from the existing store configuration, not gateway labels", () => {
  assert.equal(
    getPaymentRewardModeFromConfiguration('{"paymentMode":"ONLINE"}'),
    PaymentRewardMode.ONLINE,
  );
  assert.equal(
    getPaymentRewardModeFromConfiguration('{"paymentMode":"COD"}'),
    PaymentRewardMode.MANUAL,
  );
  assert.equal(
    getPaymentRewardModeFromConfiguration('{"paymentMode":"MANUAL"}'),
    PaymentRewardMode.MANUAL,
  );
  assert.equal(
    getPaymentRewardModeFromCustomizations([]),
    PaymentRewardMode.MANUAL,
  );
  assert.equal(
    getPaymentRewardModeFromCustomizations([{ enabled: true, metafield: null }]),
    PaymentRewardMode.ONLINE,
  );
});

test("partial fulfillment remains pending and earns no reward", () => {
  const order = resolvedOrder({
    lineItems: threeProducts,
    fulfillments: [{ lines: [{ id: "a", quantity: 1 }, { id: "b", quantity: 1 }] }],
    fulfillmentOrderStatus: "IN_PROGRESS",
    fulfillable: true,
  });

  assert.equal(isOrderFulfillmentResolutionComplete(order), false);
  assert.deepEqual(getRewardEligibleLineItems(order), []);
});

test("terminal fulfillment credits only fulfilled lines when other products are cancelled", () => {
  const order = resolvedOrder({
    lineItems: threeProducts,
    fulfillments: [{ lines: [{ id: "a", quantity: 1 }, { id: "c", quantity: 1 }] }],
    fulfillmentOrderStatus: "CANCELLED",
  });

  assert.deepEqual(getRewardEligibleLineItems(order), [
    { id: "a", product_id: "product-a", quantity: 1, title: "Product A" },
    { id: "c", product_id: "product-c", quantity: 1, title: "Product C" },
  ]);
});

test("cancelled reward products and pre-finalization refunds earn zero", () => {
  const order = resolvedOrder({
    lineItems: threeProducts,
    fulfillments: [{ lines: [{ id: "a", quantity: 1 }, { id: "c", quantity: 1 }] }],
    refunds: [{ lines: [{ id: "a", quantity: 1 }] }],
  });

  assert.deepEqual(getRewardEligibleLineItems(order), [
    { id: "c", product_id: "product-c", quantity: 1, title: "Product C" },
  ]);
});

test("refund line quantities stay attributed to the affected fulfilled product", () => {
  const order = resolvedOrder({
    lineItems: threeProducts,
    fulfillments: [{ lines: [{ id: "a", quantity: 1 }, { id: "c", quantity: 1 }] }],
    refunds: [{ lines: [{ id: "a", quantity: 1 }] }],
  });

  assert.deepEqual(
    Object.fromEntries(getRefundedLineItemQuantities(order)),
    { a: 1 },
  );
});

test("a cancelled non-reward product does not reduce fulfilled reward lines", () => {
  const order = resolvedOrder({
    lineItems: [
      { id: "reward", productId: "product-a", quantity: 1, title: "Reward" },
      { id: "none", productId: "product-b", quantity: 1, title: "No Reward" },
    ],
    fulfillments: [{ lines: [{ id: "reward", quantity: 1 }] }],
    fulfillmentOrderStatus: "CANCELLED",
  });

  const credits = calculateOrderRewardCredits({
    lineItems: getRewardEligibleLineItems(order),
    rewardByProductId: new Map([
      ["gid://shopify/Product/product-a", { title: "Reward", rewardCoins: 100 }],
      ["gid://shopify/Product/product-b", { title: "No Reward", rewardCoins: 0 }],
    ]),
  });

  assert.deepEqual(
    credits.map(({ productId, coins }) => ({ productId, coins })),
    [{ productId: "product-a", coins: 100 }],
  );
});

test("the same line fulfilled in multiple shipments is aggregated once", () => {
  const order = resolvedOrder({
    lineItems: [{ id: "a", productId: "product-a", quantity: 5, title: "Product A" }],
    fulfillments: [
      { lines: [{ id: "a", quantity: 2 }] },
      { lines: [{ id: "a", quantity: 3 }] },
    ],
  });

  assert.deepEqual(getRewardEligibleLineItems(order), [
    { id: "a", product_id: "product-a", quantity: 5, title: "Product A" },
  ]);
});

test("partial fulfillment followed by final fulfillment rewards every fulfilled quantity", () => {
  const order = resolvedOrder({
    lineItems: [{ id: "a", productId: "product-a", quantity: 2, title: "Product A" }],
    fulfillments: [
      { lines: [{ id: "a", quantity: 1 }] },
      { lines: [{ id: "a", quantity: 1 }] },
    ],
  });

  assert.deepEqual(getRewardEligibleLineItems(order), [
    { id: "a", product_id: "product-a", quantity: 2, title: "Product A" },
  ]);
});

test("product reward calculation uses the metafield floor times ordered quantity", () => {
  const credits = calculateOrderRewardCredits({
    lineItems: [
      { id: "one", product_id: "product-25", quantity: 1, title: "Product 25" },
      { id: "two", product_id: "product-25-x2", quantity: 2, title: "Product 25 x2" },
      { id: "three", product_id: "product-30", quantity: 1, title: "Product 30" },
      { id: "decimal", product_id: "product-decimal", quantity: 1, title: "Decimal" },
      { id: "missing", product_id: "product-missing", quantity: 1, title: "Missing" },
      { id: "invalid", product_id: "product-invalid", quantity: 1, title: "Invalid" },
    ],
    rewardByProductId: new Map([
      ["gid://shopify/Product/product-25", { title: "Product 25", rewardCoins: 25 }],
      ["gid://shopify/Product/product-25-x2", { title: "Product 25 x2", rewardCoins: 25 }],
      ["gid://shopify/Product/product-30", { title: "Product 30", rewardCoins: 30 }],
      ["gid://shopify/Product/product-decimal", { title: "Decimal", rewardCoins: 10.9 }],
      ["gid://shopify/Product/product-invalid", { title: "Invalid", rewardCoins: "not-a-number" }],
    ]),
  });

  assert.deepEqual(
    credits.map(({ productId, quantity, coins }) => ({ productId, quantity, coins })),
    [
      { productId: "product-25", quantity: 1, coins: 25 },
      { productId: "product-25-x2", quantity: 2, coins: 50 },
      { productId: "product-30", quantity: 1, coins: 30 },
      { productId: "product-decimal", quantity: 1, coins: 10 },
    ],
  );
});

test("numeric and GraphQL line-item IDs share one paid-order reward identity", () => {
  const input = {
    shop: "example.myshopify.com",
    orderId: "101",
    lineItemId: "201",
    lineIndex: 0,
  };

  assert.equal(
    getOrderRewardTransactionKey({ ...input, rewardedQuantity: 5 }),
    getOrderRewardTransactionKey({ ...input, rewardedQuantity: 2 }),
  );
  assert.equal(
    getOrderRewardTransactionKey({ ...input, lineItemId: "gid://shopify/LineItem/201" }),
    getOrderRewardTransactionKey(input),
  );
  assert.equal(normalizeShopifyLegacyId(201), "201");
  assert.equal(normalizeShopifyLegacyId("201"), "201");
  assert.equal(normalizeShopifyLegacyId("gid://shopify/LineItem/201"), "201");
});

test("canonical reward keys isolate orders and line items", () => {
  const base = { shop: "example.myshopify.com", orderId: "101", lineItemId: "201" };
  assert.notEqual(
    getOrderRewardTransactionKey(base),
    getOrderRewardTransactionKey({ ...base, orderId: "102" }),
  );
  assert.notEqual(
    getOrderRewardTransactionKey(base),
    getOrderRewardTransactionKey({ ...base, lineItemId: "202" }),
  );
});

test("replayed orders/paid processing credits a line once", async () => {
  const creditsByKey = new Map();
  const credit = async (input) => {
    const duplicate = creditsByKey.has(input.transactionKey);
    creditsByKey.set(input.transactionKey, input);
    return { duplicate };
  };
  const admin = {
    graphql: async () => ({
      json: async () => ({
        data: {
          nodes: [{
            id: "gid://shopify/Product/product-a",
            title: "Product A",
            metafield: { value: "10" },
          }],
        },
      }),
    }),
  };
  const order = {
    id: "101",
    name: "#101",
    line_items: [{ id: "201", product_id: "product-a", quantity: 5, title: "Product A" }],
  };

  const first = await awardOrderRewardCoins({
    admin,
    shop: "example.myshopify.com",
    customerId: "42",
    order,
    credit,
  });
  const duplicatePaid = await awardOrderRewardCoins({
    admin,
    shop: "example.myshopify.com",
    customerId: "42",
    order: {
      ...order,
      line_items: [{
        ...order.line_items[0],
        id: "gid://shopify/LineItem/201",
      }],
    },
    credit,
  });
  const duplicatePaidAgain = await awardOrderRewardCoins({
    admin,
    shop: "example.myshopify.com",
    customerId: "42",
    order,
    credit,
  });

  assert.equal(first.rewardCredits[0].coins, 50);
  assert.equal(first.creditResults[0].result.duplicate, false);
  assert.equal(duplicatePaid.creditResults[0].result.duplicate, true);
  assert.equal(duplicatePaidAgain.creditResults[0].result.duplicate, true);
  assert.equal(creditsByKey.size, 1);
  assert.deepEqual(creditsByKey.values().next().value, {
    shop: "example.myshopify.com",
    customerId: "42",
    coins: 50,
    transactionKey: "order-reward:example.myshopify.com:101:line:201",
    orderId: "101",
    orderName: "#101",
    productId: "product-a",
    productTitle: "Product A",
    lineItemId: "201",
    rewardQuantity: 5,
    description: "Reward coins earned from #101",
  });
});

test("historical order-paid and order-delivered transaction keys are never rewritten", () => {
  assert.equal(
    getOrderRewardTransactionKey({
      shop: "example.myshopify.com",
      orderId: "101",
      lineItemId: "201",
    }),
    "order-reward:example.myshopify.com:101:line:201",
  );
});
