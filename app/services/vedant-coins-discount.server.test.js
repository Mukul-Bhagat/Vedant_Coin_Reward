import assert from "node:assert/strict";
import test from "node:test";
import { ensureVedantCoinsAutomaticDiscount } from "./vedant-coins-discount.server.js";

const APP_KEY = "vedant-app-key";
const CURRENT_FUNCTION_ID = "function-current";

function automaticDiscount({ functionId = CURRENT_FUNCTION_ID, status = "ACTIVE", endsAt = null } = {}) {
  return {
    id: "gid://shopify/DiscountAutomaticNode/1",
    discount: {
      __typename: "DiscountAutomaticApp",
      title: "Vedant Coins",
      status,
      endsAt,
      appDiscountType: {
        appKey: APP_KEY,
        functionId,
        discountClasses: ["ORDER"],
      },
    },
  };
}

function appDiscountTypesResponse() {
  return {
    data: {
      appDiscountTypes: [
        {
          appKey: APP_KEY,
          title: "coin-discount-v2",
          description: "coin-discount-v2",
          functionId: CURRENT_FUNCTION_ID,
          discountClasses: ["ORDER"],
        },
      ],
    },
  };
}

function discountNodesResponse(nodes) {
  return {
    data: {
      discountNodes: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function mutationResponse(operation, discount, userErrors = []) {
  return {
    data: {
      [operation]: {
        automaticAppDiscount: discount,
        userErrors,
      },
    },
  };
}

function adminWith(responses) {
  const requests = [];
  return {
    requests,
    admin: {
      graphql: async (query, options) => {
        requests.push({ query, variables: options?.variables });
        const response = responses.shift();
        assert.ok(response, "unexpected Admin GraphQL request");
        return { json: async () => response };
      },
    },
  };
}

test("creates one automatic Vedant Coins discount when none exists", async () => {
  const created = {
    discountId: "gid://shopify/DiscountAutomaticNode/1",
    ...automaticDiscount().discount,
  };
  const { admin, requests } = adminWith([
    appDiscountTypesResponse(),
    discountNodesResponse([]),
    mutationResponse("discountAutomaticAppCreate", created),
  ]);

  const result = await ensureVedantCoinsAutomaticDiscount(admin, { appKey: APP_KEY });

  assert.deepEqual(result, {
    created: true,
    updated: false,
    existing: false,
    discountId: "gid://shopify/DiscountAutomaticNode/1",
    functionId: CURRENT_FUNCTION_ID,
    status: "ACTIVE",
  });
  assert.match(requests[2].query, /discountAutomaticAppCreate/);
  assert.deepEqual(requests[2].variables.automaticAppDiscount.discountClasses, ["ORDER"]);
  assert.equal(requests[2].variables.automaticAppDiscount.functionHandle, "coin-discount-v2");
});

test("does nothing when the correct automatic discount is already active", async () => {
  const { admin, requests } = adminWith([
    appDiscountTypesResponse(),
    discountNodesResponse([automaticDiscount()]),
  ]);

  const result = await ensureVedantCoinsAutomaticDiscount(admin, { appKey: APP_KEY });

  assert.deepEqual(result, {
    created: false,
    updated: false,
    existing: true,
    discountId: "gid://shopify/DiscountAutomaticNode/1",
    functionId: CURRENT_FUNCTION_ID,
    status: "ACTIVE",
  });
  assert.equal(requests.length, 2);
});

test("reconciles a stale Function ID without creating another discount", async () => {
  const stale = automaticDiscount({ functionId: "function-old" });
  const updated = {
    discountId: stale.id,
    ...automaticDiscount().discount,
  };
  const { admin, requests } = adminWith([
    appDiscountTypesResponse(),
    discountNodesResponse([stale]),
    mutationResponse("discountAutomaticAppUpdate", updated),
  ]);

  const result = await ensureVedantCoinsAutomaticDiscount(admin, { appKey: APP_KEY });

  assert.equal(result.updated, true);
  assert.equal(result.created, false);
  assert.match(requests[2].query, /discountAutomaticAppUpdate/);
  assert.equal(requests[2].variables.id, stale.id);
  assert.equal(requests[2].variables.automaticAppDiscount.functionHandle, "coin-discount-v2");
});

test("surfaces Shopify userErrors from creation", async () => {
  const { admin } = adminWith([
    appDiscountTypesResponse(),
    discountNodesResponse([]),
    mutationResponse("discountAutomaticAppCreate", null, [
      { field: ["automaticAppDiscount", "functionHandle"], message: "Could not find Function", code: "INVALID" },
    ]),
  ]);

  await assert.rejects(
    ensureVedantCoinsAutomaticDiscount(admin, { appKey: APP_KEY }),
    /automaticAppDiscount\.functionHandle: Could not find Function \(INVALID\)/,
  );
});

test("two sequential ensure calls create only one discount", async () => {
  const created = {
    discountId: "gid://shopify/DiscountAutomaticNode/1",
    ...automaticDiscount().discount,
  };
  const { admin, requests } = adminWith([
    appDiscountTypesResponse(),
    discountNodesResponse([]),
    mutationResponse("discountAutomaticAppCreate", created),
    appDiscountTypesResponse(),
    discountNodesResponse([automaticDiscount()]),
  ]);

  const first = await ensureVedantCoinsAutomaticDiscount(admin, { appKey: APP_KEY });
  const second = await ensureVedantCoinsAutomaticDiscount(admin, { appKey: APP_KEY });

  assert.equal(first.created, true);
  assert.equal(second.existing, true);
  assert.equal(requests.filter(({ query }) => query.includes("discountAutomaticAppCreate")).length, 1);
});
