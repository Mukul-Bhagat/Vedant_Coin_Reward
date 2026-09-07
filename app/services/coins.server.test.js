import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "../db.server.js";
import {
  calculateRedeemableCoins,
  calculateRefundRatio,
  commitCoinReservation,
  createCoinReservation,
  creditCoins,
  getCoinBalance,
  reconcileCoinReservation,
  releaseCoinReservation,
  releaseExpiredCoinReservations,
  reserveCoins,
  reverseOrderCoinTransactions,
} from "./coins.server.js";
import { isCashOnDeliveryOrder } from "./order-payment.server.js";
import {
  calculateOrderRewardCredits,
  getPaidOrderRewardTransactionKey,
} from "./order-coins.server.js";
import { authorizeCoinDiscount } from "./coin-authorization.server.js";

const shop = `coin-test-${Date.now()}.myshopify.com`;
const customerId = `customer-${Date.now()}`;
const balanceKey = { shop_customerId: { shop, customerId } };

async function balance() {
  return prisma.customerCoinBalance.findUnique({
    where: balanceKey,
  });
}

async function balanceFor(shop, customerId) {
  const record = await prisma.customerCoinBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
    select: { availableCoins: true, reservedCoins: true },
  });
  return record;
}

async function cleanupShop(shop) {
  await prisma.coinTransaction.deleteMany({ where: { shop } });
  await prisma.coinReservation.deleteMany({ where: { shop } });
  await prisma.customerCoinBalance.deleteMany({ where: { shop } });
}

async function assertCoinInvariants(shop, customerId) {
  const balanceRecord = await balanceFor(shop, customerId);
  assert.ok(balanceRecord);
  assert.ok(balanceRecord.availableCoins >= 0);
  assert.ok(balanceRecord.reservedCoins >= 0);

  const [reservations, transactions] = await Promise.all([
    prisma.coinReservation.findMany({ where: { shop, customerId } }),
    prisma.coinTransaction.findMany({ where: { shop, customerId } }),
  ]);
  const activeCoins = reservations
    .filter((reservation) => reservation.status === "ACTIVE")
    .reduce((total, reservation) => total + reservation.coins, 0);

  assert.equal(activeCoins, balanceRecord.reservedCoins);

  for (const reservation of reservations) {
    const transaction = transactions.find(
      (candidate) => candidate.transactionKey === `coin-reservation:${reservation.id}`,
    );
    assert.ok(transaction);

    if (reservation.status === "ACTIVE") {
      assert.equal(transaction.status, "PENDING");
    } else if (reservation.status === "COMPLETED") {
      assert.equal(transaction.status, "COMPLETED");
    } else if (reservation.status === "CANCELLED") {
      assert.equal(transaction.status, "CANCELLED");
    }
  }

  for (const transaction of transactions.filter(
    (candidate) => candidate.transactionKey.startsWith("coin-reservation:"),
  )) {
    const reservationId = transaction.transactionKey.slice("coin-reservation:".length);
    const reservation = reservations.find((candidate) => candidate.id === reservationId);
    if (!reservation) {
      // A cancelled reservation may be removed before reusing its unique cart token.
      assert.equal(transaction.status, "CANCELLED");
      continue;
    }
    assert.notEqual(
      transaction.status === "PENDING" && reservation.status === "COMPLETED",
      true,
    );
    assert.notEqual(
      transaction.status === "COMPLETED" && reservation.status === "CANCELLED",
      true,
    );
  }

  return { balanceRecord, reservations, transactions };
}

after(async () => {
  await prisma.coinTransaction.deleteMany({ where: { shop } });
  await prisma.coinReservation.deleteMany({ where: { shop } });
  await prisma.customerCoinBalance.deleteMany({ where: { shop } });
  await prisma.$disconnect();
});

test("coin service handles balances, reservations, expiry, and idempotency", async () => {
  const first = await creditCoins({
    shop,
    customerId,
    coins: 100,
    transactionKey: "credit:first",
    orderId: "order-1",
  });
  assert.equal(first.balance, 100);
  assert.equal((await balance()).reservedCoins, 0);

  const second = await creditCoins({
    shop,
    customerId,
    coins: 25,
    transactionKey: "credit:second",
  });
  assert.equal(second.balance, 125);
  const duplicate = await creditCoins({
    shop,
    customerId,
    coins: 25,
    transactionKey: "credit:second",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await balance()).availableCoins, 125);

  await assert.rejects(() =>
    creditCoins({
      shop,
      customerId,
      coins: 0,
      transactionKey: "credit:zero",
    }),
  );
  await assert.rejects(() =>
    creditCoins({
      shop,
      customerId,
      coins: -1,
      transactionKey: "credit:negative",
    }),
  );

  assert.equal(
    calculateRedeemableCoins({ availableCoins: 125, orderAmount: 749.95 }),
    125,
  );
  assert.equal(
    calculateRedeemableCoins({ availableCoins: 1000, orderAmount: 1499.9 }),
    1000,
  );
  assert.equal(calculateRefundRatio({ refundedAmount: 250, orderSubtotal: 1000 }), 0.25);

  const reservation = await createCoinReservation({
    shop,
    customerId,
    cartToken: "cart-a",
    requestedCoins: 25,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(reservation.availableCoins, 100);
  assert.equal(reservation.reservedCoins, 25);
  assert.equal((await balance()).availableCoins, 100);
  assert.equal((await balance()).reservedCoins, 25);

  assert.deepEqual(
    await authorizeCoinDiscount({
      shop,
      customerId,
      cartToken: "cart-a",
      requestedCoins: 25,
      merchandiseSubtotal: 749.95,
    }),
    { authorized: true, coins: 25 },
  );
  assert.equal(
    (await authorizeCoinDiscount({
      shop,
      customerId,
      cartToken: "cart-a",
      requestedCoins: 100000,
      merchandiseSubtotal: 749.95,
    })).authorized,
    false,
  );
  assert.equal(
    (await authorizeCoinDiscount({
      shop,
      customerId: "another-customer",
      cartToken: "cart-a",
      requestedCoins: 25,
      merchandiseSubtotal: 749.95,
    })).authorized,
    false,
  );

  const sameReservation = await createCoinReservation({
    shop,
    customerId,
    cartToken: "cart-a",
    requestedCoins: 25,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(sameReservation.duplicate, true);

  await assert.rejects(() =>
    createCoinReservation({
      shop,
      customerId,
      cartToken: "cart-too-large",
      requestedCoins: 101,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );

  const released = await releaseCoinReservation({
    shop,
    customerId,
    transactionKey: `coin-reservation:${reservation.reservation.id}`,
  });
  assert.equal(released.balance, 125);
  const releasedAgain = await releaseCoinReservation({
    shop,
    customerId,
    transactionKey: `coin-reservation:${reservation.reservation.id}`,
  });
  assert.equal(releasedAgain.duplicate, true);

  const changedReservation = await createCoinReservation({
    shop,
    customerId,
    cartToken: "cart-a",
    requestedCoins: 30,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(changedReservation.reservation.coins, 30);
  await releaseCoinReservation({
    shop,
    customerId,
    transactionKey: `coin-reservation:${changedReservation.reservation.id}`,
  });

  const committed = await createCoinReservation({
    shop,
    customerId,
    cartToken: "cart-b",
    requestedCoins: 40,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const committedResult = await commitCoinReservation({
    shop,
    customerId,
    transactionKey: `coin-reservation:${committed.reservation.id}`,
  });
  assert.equal(committedResult.balance, 85);
  assert.equal((await balance()).reservedCoins, 0);
  assert.equal(
    (await commitCoinReservation({
      shop,
      customerId,
      transactionKey: `coin-reservation:${committed.reservation.id}`,
    })).duplicate,
    true,
  );
  await prisma.coinTransaction.update({
    where: {
      transactionKey: `coin-reservation:${committed.reservation.id}`,
    },
    data: {
      orderId: "order-redeem",
    },
  });
  const redeemedReversal = await reverseOrderCoinTransactions({
    shop,
    orderId: "order-redeem",
    eventKey: "refund:redeemed",
    refundRatio: 0.5,
  });
  assert.equal(redeemedReversal.reversedCoins, 20);
  await assert.rejects(() =>
    releaseCoinReservation({
      shop,
      customerId,
      transactionKey: `coin-reservation:${committed.reservation.id}`,
    }),
  );

  const cancelled = await createCoinReservation({
    shop,
    customerId,
    cartToken: "cart-c",
    requestedCoins: 10,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await releaseCoinReservation({
    shop,
    customerId,
    transactionKey: `coin-reservation:${cancelled.reservation.id}`,
  });
  await assert.rejects(() =>
    commitCoinReservation({
      shop,
      customerId,
      transactionKey: `coin-reservation:${cancelled.reservation.id}`,
    }),
  );

  const expired = await createCoinReservation({
    shop,
    customerId,
    cartToken: "cart-expired",
    requestedCoins: 15,
    expiresAt: new Date(Date.now() - 1),
  });
  const cleanup = await releaseExpiredCoinReservations({ shop, customerId });
  assert.equal(cleanup.released, 1);
  assert.equal((await balance()).reservedCoins, 0);
  assert.equal((await balance()).availableCoins, 105);
  assert.equal((await releaseExpiredCoinReservations({ shop, customerId })).released, 0);
  assert.equal(expired.reservation.status, "ACTIVE");

  const concurrent = await Promise.allSettled([
    createCoinReservation({
      shop,
      customerId,
      cartToken: "cart-concurrent-a",
      requestedCoins: 60,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createCoinReservation({
      shop,
      customerId,
      cartToken: "cart-concurrent-b",
      requestedCoins: 60,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  ]);
  assert.ok(concurrent.filter((result) => result.status === "fulfilled").length <= 1);
  const finalBalance = await balance();
  assert.ok(finalBalance.availableCoins >= 0);
  assert.ok(finalBalance.reservedCoins >= 0);

  await reverseOrderCoinTransactions({
    shop,
    orderId: "order-1",
    eventKey: "refund:one",
  });
  const reversalAgain = await reverseOrderCoinTransactions({
    shop,
    orderId: "order-1",
    eventKey: "refund:one",
  });
  assert.equal(reversalAgain.duplicate, true);

  await creditCoins({
    shop,
    customerId,
    coins: 80,
    transactionKey: "credit:partial-refund",
    orderId: "order-partial",
  });
  const partialFirst = await reverseOrderCoinTransactions({
    shop,
    orderId: "order-partial",
    eventKey: "refund:partial-1",
    refundRatio: 0.25,
  });
  assert.equal(partialFirst.reversedCoins, 20);
  const partialSecond = await reverseOrderCoinTransactions({
    shop,
    orderId: "order-partial",
    eventKey: "refund:partial-2",
    refundRatio: 1,
  });
  assert.equal(partialSecond.reversedCoins, 60);

  const ledger = await prisma.coinTransaction.findMany({
    where: { shop, customerId },
  });
  assert.equal(
    new Set(ledger.map((transaction) => transaction.transactionKey)).size,
    ledger.length,
  );
  const finalLedgerBalance = await balance();
  assert.ok(finalLedgerBalance.availableCoins >= 0);
  assert.ok(finalLedgerBalance.reservedCoins >= 0);
});

test("paid order reward calculation uses metafields and quantity", () => {
  const rewardByProductId = new Map([
    ["gid://shopify/Product/1", { title: "Cake Stand", rewardCoins: 50 }],
    ["gid://shopify/Product/2", { title: "Cake Cream", rewardCoins: 25 }],
    ["gid://shopify/Product/3", { title: "No Reward", rewardCoins: 0 }],
  ]);

  const credits = calculateOrderRewardCredits({
    rewardByProductId,
    lineItems: [
      { id: "line-1", product_id: 1, quantity: 2, title: "Cake Stand" },
      { id: "line-2", product_id: 2, quantity: 3, title: "Cake Cream" },
      { id: "line-3", product_id: 3, quantity: 9, title: "No Reward" },
    ],
  });

  assert.deepEqual(
    credits.map((credit) => credit.coins),
    [100, 75],
  );

  assert.equal(
    getPaidOrderRewardTransactionKey({
      orderId: "order-123",
      lineItemId: "line-456",
      lineIndex: credits[0].index,
    }),
    "order-paid:order-123:line:line-456",
  );
  assert.equal(
    getPaidOrderRewardTransactionKey({
      orderId: "order-123",
      lineIndex: credits[1].index,
    }),
    "order-paid:order-123:line-index:1",
  );
  assert.throws(() =>
    getPaidOrderRewardTransactionKey({
      orderId: "order-123",
      lineIndex: -1,
    }),
  );
});

test("balance lookup releases an expired reservation before returning coins", async () => {
  const isolatedShop = `balance-expiry-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `balance-expiry-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "balance-expiry:credit",
    });
    const reservation = await createCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "balance-expiry-cart",
      requestedCoins: 50,
      expiresAt: new Date(Date.now() - 1),
    });

    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    assert.equal(await getCoinBalance(isolatedShop, isolatedCustomer), 50);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 50,
      reservedCoins: 0,
    });

    const storedReservation = await prisma.coinReservation.findUnique({
      where: { id: reservation.reservation.id },
    });
    const storedTransaction = await prisma.coinTransaction.findUnique({
      where: { transactionKey: `coin-reservation:${reservation.reservation.id}` },
    });
    assert.equal(storedReservation.status, "CANCELLED");
    assert.equal(storedTransaction.status, "CANCELLED");
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("reserveCoins releases an expired reservation before reserving again", async () => {
  const isolatedShop = `reserve-expiry-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `reserve-expiry-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "reserve-expiry:credit",
    });
    const expired = await createCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "reserve-expiry-old-cart",
      requestedCoins: 50,
      expiresAt: new Date(Date.now() - 1),
    });

    const replacement = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "reserve-expiry-new-cart",
      requestedCoins: 50,
      expiresAt: new Date(Date.now() + 60_000),
    });

    assert.equal(replacement.duplicate, false);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    const activeReservations = await prisma.coinReservation.findMany({
      where: { shop: isolatedShop, status: "ACTIVE" },
    });
    assert.deepEqual(activeReservations.map(({ id }) => id), [replacement.reservation.id]);

    const oldReservation = await prisma.coinReservation.findUnique({
      where: { id: expired.reservation.id },
    });
    const oldTransaction = await prisma.coinTransaction.findUnique({
      where: { transactionKey: `coin-reservation:${expired.reservation.id}` },
    });
    assert.equal(oldReservation.status, "CANCELLED");
    assert.equal(oldTransaction.status, "CANCELLED");
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("balance lookup does not release an active reservation", async () => {
  const isolatedShop = `active-expiry-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `active-expiry-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "active-expiry:credit",
    });
    const reservation = await createCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "active-expiry-cart",
      requestedCoins: 50,
      expiresAt: new Date(Date.now() + 60_000),
    });

    assert.equal(await getCoinBalance(isolatedShop, isolatedCustomer), 0);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    const storedReservation = await prisma.coinReservation.findUnique({
      where: { id: reservation.reservation.id },
    });
    assert.equal(storedReservation.status, "ACTIVE");
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("concurrent reservations cannot spend more than the available balance", async () => {
  const isolatedShop = `concurrent-expiry-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `concurrent-expiry-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "concurrent-expiry:credit",
    });

    const results = await Promise.allSettled([
      reserveCoins({
        shop: isolatedShop,
        customerId: isolatedCustomer,
        cartToken: "concurrent-expiry-cart-a",
        requestedCoins: 50,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      reserveCoins({
        shop: isolatedShop,
        customerId: isolatedCustomer,
        cartToken: "concurrent-expiry-cart-b",
        requestedCoins: 50,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    assert.ok(results.filter((result) => result.status === "fulfilled").length <= 1);
    const balanceRecord = await balanceFor(isolatedShop, isolatedCustomer);
    const activeReservations = await prisma.coinReservation.findMany({
      where: { shop: isolatedShop, status: "ACTIVE" },
      select: { coins: true },
    });
    const activeCoins = activeReservations.reduce((total, reservation) => total + reservation.coins, 0);
    assert.ok(balanceRecord.availableCoins >= 0);
    assert.ok(balanceRecord.reservedCoins >= 0);
    assert.ok(activeCoins <= 50);
    assert.ok(balanceRecord.reservedCoins <= 50);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("releasing an empty-cart reservation restores 50 coins exactly once", async () => {
  const isolatedShop = `empty-cart-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `empty-cart-customer-${Date.now()}`;
  const cartToken = "empty-cart-token?key=test";

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "empty-cart:credit",
    });

    const reservation = await createCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      requestedCoins: 50,
      expiresAt: new Date(Date.now() + 60_000),
    });

    assert.deepEqual(
      await balanceFor(isolatedShop, isolatedCustomer),
      { availableCoins: 0, reservedCoins: 50 },
    );

    await assert.rejects(() =>
      releaseCoinReservation({
        shop: isolatedShop,
        customerId: "different-customer",
        transactionKey: `coin-reservation:${reservation.reservation.id}`,
      }),
    );

    const released = await releaseCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      transactionKey: `coin-reservation:${reservation.reservation.id}`,
    });
    assert.equal(released.balance, 50);
    assert.deepEqual(
      await balanceFor(isolatedShop, isolatedCustomer),
      { availableCoins: 50, reservedCoins: 0 },
    );

    const releasedAgain = await releaseCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      transactionKey: `coin-reservation:${reservation.reservation.id}`,
    });
    assert.equal(releasedAgain.duplicate, true);
    assert.deepEqual(
      await balanceFor(isolatedShop, isolatedCustomer),
      { availableCoins: 50, reservedCoins: 0 },
    );
  } finally {
    await prisma.coinTransaction.deleteMany({ where: { shop: isolatedShop } });
    await prisma.coinReservation.deleteMany({ where: { shop: isolatedShop } });
    await prisma.customerCoinBalance.deleteMany({ where: { shop: isolatedShop } });
  }
});

test("cart fingerprint reconciliation releases changed checkout state exactly once", async () => {
  const isolatedShop = `fingerprint-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `fingerprint-customer-${Date.now()}`;
  const cartToken = "fingerprint-cart?key=test";

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "fingerprint:credit",
    });

    const reservation = await createCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      cartFingerprint: "cart-a",
      requestedCoins: 50,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const unchanged = await reconcileCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      reservationId: reservation.reservation.id,
      cartToken,
      cartFingerprint: "cart-a",
    });
    assert.equal(unchanged.released, false);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });

    const changed = await reconcileCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      reservationId: reservation.reservation.id,
      cartToken,
      cartFingerprint: "cart-b",
    });
    assert.equal(changed.released, true);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 50,
      reservedCoins: 0,
    });

    const repeated = await reconcileCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      reservationId: reservation.reservation.id,
      cartToken,
      cartFingerprint: "cart-c",
    });
    assert.equal(repeated.released, false);
  } finally {
    await prisma.coinTransaction.deleteMany({ where: { shop: isolatedShop } });
    await prisma.coinReservation.deleteMany({ where: { shop: isolatedShop } });
    await prisma.customerCoinBalance.deleteMany({ where: { shop: isolatedShop } });
  }
});

test("cart-token commits attach order metadata and remain idempotent", async () => {
  const isolatedShop = `order-commit-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `order-commit-customer-${Date.now()}`;
  const cartToken = "cod-cart?key=test";

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "order-commit:credit",
    });
    await createCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      requestedCoins: 50,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await commitCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      orderId: "order-cod-1",
      orderName: "#COD1",
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.transaction.status, "COMPLETED");
    assert.equal(first.transaction.orderId, "order-cod-1");
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 0,
    });

    const duplicate = await commitCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      orderId: "order-cod-1",
    });
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 0,
    });
  } finally {
    await prisma.coinTransaction.deleteMany({ where: { shop: isolatedShop } });
    await prisma.coinReservation.deleteMany({ where: { shop: isolatedShop } });
    await prisma.customerCoinBalance.deleteMany({ where: { shop: isolatedShop } });
  }
});

test("COD detection only matches explicit COD gateway names", () => {
  assert.equal(
    isCashOnDeliveryOrder({ payment_gateway_names: ["Cash on Delivery (COD)"] }),
    true,
  );
  assert.equal(
    isCashOnDeliveryOrder({ gateway: "shopify_payments", payment_gateway_names: ["Shopify Payments"] }),
    false,
  );
});

test("full lifecycle group 1: balance starts with 50 available coins", async () => {
  const isolatedShop = `matrix-balance-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-balance-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-balance:credit",
    });

    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 50,
      reservedCoins: 0,
    });
    assert.equal(await getCoinBalance(isolatedShop, isolatedCustomer), 50);
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle group 2: reservation is temporary and carries exact identity", async () => {
  const isolatedShop = `matrix-reservation-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-reservation-customer-${Date.now()}`;
  const cartToken = "matrix-cart?key=raw-token-key";

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-reservation:credit",
    });
    const reservationStartedAt = Date.now();
    const result = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      cartFingerprint: "fingerprint-a",
      requestedCoins: 50,
    });
    const expiresIn = result.reservation.expiresAt.getTime() - reservationStartedAt;
    assert.ok(expiresIn >= 599_000 && expiresIn <= 601_000);

    const reservation = await prisma.coinReservation.findUnique({
      where: { id: result.reservation.id },
    });
    const transaction = await prisma.coinTransaction.findUnique({
      where: { transactionKey: `coin-reservation:${result.reservation.id}` },
    });
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    assert.equal(reservation.status, "ACTIVE");
    assert.equal(reservation.shop, isolatedShop);
    assert.equal(reservation.customerId, isolatedCustomer);
    assert.equal(reservation.cartToken, cartToken);
    assert.equal(reservation.cartFingerprint, "fingerprint-a");
    assert.equal(reservation.coins, 50);
    assert.equal(transaction.status, "PENDING");
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle group 3: duplicate reservation does not deduct twice", async () => {
  const isolatedShop = `matrix-duplicate-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-duplicate-customer-${Date.now()}`;
  const cartToken = "matrix-duplicate-cart?key=raw-token-key";

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-duplicate:credit",
    });
    const first = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      requestedCoins: 50,
    });
    const duplicate = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      requestedCoins: 50,
    });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.reservation.id, first.reservation.id);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    assert.equal(
      await prisma.coinReservation.count({ where: { shop: isolatedShop, status: "ACTIVE" } }),
      1,
    );
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle group 4: active reservation protects the remaining balance", async () => {
  const isolatedShop = `matrix-protection-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-protection-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-protection:credit",
    });
    const first = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "matrix-protection-cart-a",
      requestedCoins: 50,
    });

    await assert.rejects(() => reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "matrix-protection-cart-b",
      requestedCoins: 50,
    }), /Insufficient coin balance/);

    const stored = await prisma.coinReservation.findUnique({
      where: { id: first.reservation.id },
    });
    assert.equal(stored.status, "ACTIVE");
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle groups 10 and 12: COD commit is explicit and idempotent", async () => {
  const isolatedShop = `matrix-cod-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-cod-customer-${Date.now()}`;
  const cartToken = "matrix-cod-cart?key=raw-token-key";
  const order = {
    id: "matrix-cod-order",
    name: "#MATRIX-COD",
    customer: { id: isolatedCustomer },
    cart_token: cartToken,
    payment_gateway_names: ["Cash on Delivery (COD)"],
  };

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-cod:credit",
    });
    await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      requestedCoins: 50,
    });

    assert.equal(isCashOnDeliveryOrder(order), true);
    const first = await commitCoinReservation({
      shop: isolatedShop,
      customerId: String(order.customer.id),
      cartToken: order.cart_token,
      orderId: String(order.id),
      orderName: order.name,
    });
    const duplicate = await commitCoinReservation({
      shop: isolatedShop,
      customerId: String(order.customer.id),
      cartToken: order.cart_token,
      orderId: String(order.id),
    });

    assert.equal(first.transaction.status, "COMPLETED");
    assert.equal(first.transaction.orderId, order.id);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 0,
    });
    assert.equal(
      await prisma.coinTransaction.count({
        where: { shop: isolatedShop, type: "DEBIT", status: "COMPLETED" },
      }),
      1,
    );
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle group 11: non-COD orders do not commit a reservation", async () => {
  const isolatedShop = `matrix-non-cod-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-non-cod-customer-${Date.now()}`;
  const cartToken = "matrix-non-cod-cart?key=raw-token-key";
  const order = {
    gateway: "shopify_payments",
    payment_gateway_names: ["Shopify Payments"],
  };

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-non-cod:credit",
    });
    await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      requestedCoins: 50,
    });

    assert.equal(isCashOnDeliveryOrder(order), false);
    const reservation = await prisma.coinReservation.findUnique({
      where: { shop_cartToken: { shop: isolatedShop, cartToken } },
    });
    const transaction = await prisma.coinTransaction.findUnique({
      where: { transactionKey: `coin-reservation:${reservation.id}` },
    });
    assert.equal(reservation.status, "ACTIVE");
    assert.equal(transaction.status, "PENDING");
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle group 14: same-token cart change releases and re-reserves", async () => {
  const isolatedShop = `matrix-cart-change-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-cart-change-customer-${Date.now()}`;
  const cartToken = "matrix-cart-change?key=preserved-key";

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-cart-change:credit",
    });
    const first = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      cartFingerprint: "product-a",
      requestedCoins: 50,
    });
    const reconciled = await reconcileCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      reservationId: first.reservation.id,
      cartToken,
      cartFingerprint: "product-b",
    });

    assert.equal(reconciled.released, true);
    const releasedReservation = await prisma.coinReservation.findUnique({
      where: { id: first.reservation.id },
    });
    const releasedTransaction = await prisma.coinTransaction.findUnique({
      where: { transactionKey: `coin-reservation:${first.reservation.id}` },
    });
    assert.equal(releasedReservation.status, "CANCELLED");
    assert.equal(releasedTransaction.status, "CANCELLED");
    assert.equal(await getCoinBalance(isolatedShop, isolatedCustomer), 50);
    const replacement = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken,
      cartFingerprint: "product-b",
      requestedCoins: 50,
    });
    assert.notEqual(replacement.reservation.id, first.reservation.id);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 0,
      reservedCoins: 50,
    });
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle groups 16 and 17: redeemable coins respect balance and cart limits", async () => {
  assert.equal(calculateRedeemableCoins({ availableCoins: 1000, orderAmount: 500 }), 500);
  assert.equal(calculateRedeemableCoins({ availableCoins: 300, orderAmount: 500 }), 300);

  const isolatedShop = `matrix-limits-${Date.now()}.myshopify.com`;
  const highCustomer = `matrix-limits-high-${Date.now()}`;
  const lowCustomer = `matrix-limits-low-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: highCustomer,
      coins: 1000,
      transactionKey: "matrix-limits:high-credit",
    });
    const highReservation = await reserveCoins({
      shop: isolatedShop,
      customerId: highCustomer,
      cartToken: "matrix-limits-high-cart",
      requestedCoins: 500,
    });
    await commitCoinReservation({
      shop: isolatedShop,
      customerId: highCustomer,
      reservationId: highReservation.reservation.id,
      orderId: "matrix-limits-high-order",
    });
    assert.deepEqual(await balanceFor(isolatedShop, highCustomer), {
      availableCoins: 500,
      reservedCoins: 0,
    });

    await creditCoins({
      shop: isolatedShop,
      customerId: lowCustomer,
      coins: 300,
      transactionKey: "matrix-limits:low-credit",
    });
    const lowReservation = await reserveCoins({
      shop: isolatedShop,
      customerId: lowCustomer,
      cartToken: "matrix-limits-low-cart",
      requestedCoins: 300,
    });
    await commitCoinReservation({
      shop: isolatedShop,
      customerId: lowCustomer,
      reservationId: lowReservation.reservation.id,
      orderId: "matrix-limits-low-order",
    });
    assert.deepEqual(await balanceFor(isolatedShop, lowCustomer), {
      availableCoins: 0,
      reservedCoins: 0,
    });
    await assertCoinInvariants(isolatedShop, highCustomer);
    await assertCoinInvariants(isolatedShop, lowCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle groups 18 and 19: rewards happen only after successful commit", async () => {
  const isolatedShop = `matrix-rewards-${Date.now()}.myshopify.com`;
  const successfulCustomer = `matrix-rewards-success-${Date.now()}`;
  const abandonedCustomer = `matrix-rewards-abandoned-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: successfulCustomer,
      coins: 50,
      transactionKey: "matrix-rewards:success-credit",
    });
    const reservation = await reserveCoins({
      shop: isolatedShop,
      customerId: successfulCustomer,
      cartToken: "matrix-rewards-success-cart",
      requestedCoins: 50,
    });
    await commitCoinReservation({
      shop: isolatedShop,
      customerId: successfulCustomer,
      reservationId: reservation.reservation.id,
      orderId: "matrix-rewards-order",
    });
    assert.equal((await balanceFor(isolatedShop, successfulCustomer)).availableCoins, 0);

    const rewards = calculateOrderRewardCredits({
      lineItems: [{ id: "line-1", product_id: 1, quantity: 1, title: "Reward product" }],
      rewardByProductId: new Map([
        ["gid://shopify/Product/1", { title: "Reward product", rewardCoins: 25 }],
      ]),
    });
    assert.equal(rewards[0].coins, 25);
    await creditCoins({
      shop: isolatedShop,
      customerId: successfulCustomer,
      coins: rewards[0].coins,
      transactionKey: "order-paid:matrix-rewards-order:line:line-1",
      orderId: "matrix-rewards-order",
      productId: rewards[0].productId,
    });
    assert.equal((await balanceFor(isolatedShop, successfulCustomer)).availableCoins, 25);

    await creditCoins({
      shop: isolatedShop,
      customerId: abandonedCustomer,
      coins: 50,
      transactionKey: "matrix-rewards:abandoned-credit",
    });
    await reserveCoins({
      shop: isolatedShop,
      customerId: abandonedCustomer,
      cartToken: "matrix-rewards-abandoned-cart",
      requestedCoins: 50,
      expiresAt: new Date(Date.now() - 1),
    });
    await getCoinBalance(isolatedShop, abandonedCustomer);
    assert.equal(
      await prisma.coinTransaction.count({
        where: {
          shop: isolatedShop,
          customerId: abandonedCustomer,
          type: "CREDIT",
          transactionKey: { contains: "order-paid:" },
        },
      }),
      0,
    );
    await assertCoinInvariants(isolatedShop, successfulCustomer);
    await assertCoinInvariants(isolatedShop, abandonedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle group 23: cancellation/refund restoration is idempotent", async () => {
  const isolatedShop = `matrix-refund-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-refund-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-refund:credit",
    });
    const reservation = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "matrix-refund-cart",
      requestedCoins: 50,
    });
    await commitCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      reservationId: reservation.reservation.id,
      orderId: "matrix-refund-order",
    });

    const first = await reverseOrderCoinTransactions({
      shop: isolatedShop,
      orderId: "matrix-refund-order",
      eventKey: "order-cancelled:matrix-refund-order",
    });
    const duplicate = await reverseOrderCoinTransactions({
      shop: isolatedShop,
      orderId: "matrix-refund-order",
      eventKey: "order-cancelled:matrix-refund-order",
    });

    assert.equal(first.reversedCoins, 50);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(await balanceFor(isolatedShop, isolatedCustomer), {
      availableCoins: 50,
      reservedCoins: 0,
    });
    assert.equal(
      await prisma.coinTransaction.count({
        where: { shop: isolatedShop, type: "REVERSAL", status: "COMPLETED" },
      }),
      1,
    );
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
  } finally {
    await cleanupShop(isolatedShop);
  }
});

test("full lifecycle group 25: database invariants hold across reserve, release, and commit", async () => {
  const isolatedShop = `matrix-invariants-${Date.now()}.myshopify.com`;
  const isolatedCustomer = `matrix-invariants-customer-${Date.now()}`;

  try {
    await creditCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      coins: 50,
      transactionKey: "matrix-invariants:credit",
    });
    const releasedReservation = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "matrix-invariants-release-cart",
      requestedCoins: 25,
    });
    await assertCoinInvariants(isolatedShop, isolatedCustomer);
    await releaseCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      reservationId: releasedReservation.reservation.id,
    });
    await assertCoinInvariants(isolatedShop, isolatedCustomer);

    const committedReservation = await reserveCoins({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      cartToken: "matrix-invariants-commit-cart",
      requestedCoins: 50,
    });
    await commitCoinReservation({
      shop: isolatedShop,
      customerId: isolatedCustomer,
      reservationId: committedReservation.reservation.id,
      orderId: "matrix-invariants-order",
    });
    const finalState = await assertCoinInvariants(isolatedShop, isolatedCustomer);
    assert.deepEqual(finalState.balanceRecord, {
      availableCoins: 0,
      reservedCoins: 0,
    });
  } finally {
    await cleanupShop(isolatedShop);
  }
});
