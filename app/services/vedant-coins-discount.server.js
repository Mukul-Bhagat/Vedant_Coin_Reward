const DISCOUNT_TITLE = "Vedant Coins";
const FUNCTION_HANDLE = "coin-discount-v2";
const ORDER_CLASS = "ORDER";

const APP_DISCOUNT_TYPES_QUERY = `#graphql
  query VedantCoinsAppDiscountTypes {
    appDiscountTypes {
      appKey
      title
      description
      functionId
      discountClasses
    }
  }
`;

const AUTOMATIC_DISCOUNTS_QUERY = `#graphql
  query VedantCoinsAutomaticDiscounts($after: String) {
    discountNodes(first: 250, after: $after, query: "title:'Vedant Coins'") {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticApp {
            title
            status
            endsAt
            appDiscountType {
              appKey
              functionId
              discountClasses
            }
          }
          ... on DiscountAutomaticBasic {
            title
          }
          ... on DiscountAutomaticBxgy {
            title
          }
          ... on DiscountAutomaticFreeShipping {
            title
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const CREATE_AUTOMATIC_DISCOUNT_MUTATION = `#graphql
  mutation CreateVedantCoinsAutomaticDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount {
        discountId
        title
        status
        endsAt
        appDiscountType {
          appKey
          functionId
          discountClasses
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_AUTOMATIC_DISCOUNT_MUTATION = `#graphql
  mutation UpdateVedantCoinsAutomaticDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount {
        discountId
        title
        status
        endsAt
        appDiscountType {
          appKey
          functionId
          discountClasses
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function formatUserErrors(userErrors) {
  return userErrors
    .map(({ field, message, code }) => `${field?.join(".") || "discount"}: ${message}${code ? ` (${code})` : ""}`)
    .join("; ");
}

async function graphql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`Shopify Admin GraphQL error: ${json.errors.map(({ message }) => message).join("; ")}`);
  }
  return json.data;
}

async function resolveCurrentFunction(admin, appKey) {
  const data = await graphql(admin, APP_DISCOUNT_TYPES_QUERY);
  const matchingTypes = (data.appDiscountTypes || []).filter(
    (type) =>
      type.appKey === appKey &&
      type.title === FUNCTION_HANDLE &&
      type.discountClasses?.includes(ORDER_CLASS),
  );

  if (matchingTypes.length !== 1) {
    throw new Error(
      `Expected exactly one ORDER app discount type for ${FUNCTION_HANDLE}; found ${matchingTypes.length}.`,
    );
  }

  return matchingTypes[0].functionId;
}

async function findDiscountsWithTitle(admin) {
  const discounts = [];
  let after = null;

  do {
    const data = await graphql(admin, AUTOMATIC_DISCOUNTS_QUERY, { after });
    const connection = data.discountNodes;
    discounts.push(...(connection.nodes || []).filter(({ discount }) => discount?.title === DISCOUNT_TITLE));
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return discounts;
}

function automaticDiscountInput({ activateNow = false } = {}) {
  return {
    title: DISCOUNT_TITLE,
    functionHandle: FUNCTION_HANDLE,
    discountClasses: [ORDER_CLASS],
    endsAt: null,
    ...(activateNow ? { startsAt: new Date().toISOString() } : {}),
  };
}

function resultFor(discount, { created = false, updated = false, existing = !created } = {}) {
  return {
    created,
    updated,
    existing,
    discountId: discount.discountId,
    functionId: discount.appDiscountType.functionId,
    status: discount.status,
  };
}

/**
 * Ensures that this app owns exactly one active automatic discount connected to
 * the current coin-discount-v2 Function. This is safe to call repeatedly from
 * an authenticated merchant app route; it must never be called at checkout.
 */
export async function ensureVedantCoinsAutomaticDiscount(admin, { appKey = process.env.SHOPIFY_API_KEY } = {}) {
  if (!appKey) throw new Error("SHOPIFY_API_KEY is required to resolve the Vedant Coins discount Function.");

  const functionId = await resolveCurrentFunction(admin, appKey);
  const discounts = await findDiscountsWithTitle(admin);

  if (discounts.length > 1) {
    throw new Error(`Found ${discounts.length} discounts named ${DISCOUNT_TITLE}; refusing to create another.`);
  }

  const existing = discounts[0];
  if (!existing) {
    const data = await graphql(admin, CREATE_AUTOMATIC_DISCOUNT_MUTATION, {
      automaticAppDiscount: automaticDiscountInput({ activateNow: true }),
    });
    const payload = data.discountAutomaticAppCreate;
    if (payload.userErrors?.length) throw new Error(formatUserErrors(payload.userErrors));
    if (!payload.automaticAppDiscount) throw new Error("Shopify did not return the created Vedant Coins discount.");

    console.info("[vedant-coins-discount] automatic discount created", {
      discountId: payload.automaticAppDiscount.discountId,
      functionId: payload.automaticAppDiscount.appDiscountType.functionId,
    });
    return resultFor(payload.automaticAppDiscount, { created: true });
  }

  const discount = existing.discount;
  if (discount.__typename !== "DiscountAutomaticApp" || discount.appDiscountType.appKey !== appKey) {
    throw new Error(`A non-Vedant automatic app discount already uses the title ${DISCOUNT_TITLE}; refusing to create another.`);
  }

  const needsUpdate =
    discount.appDiscountType.functionId !== functionId ||
    discount.status !== "ACTIVE" ||
    discount.endsAt !== null ||
    !discount.appDiscountType.discountClasses?.includes(ORDER_CLASS);

  if (!needsUpdate) {
    return resultFor({ discountId: existing.id, ...discount });
  }

  const data = await graphql(admin, UPDATE_AUTOMATIC_DISCOUNT_MUTATION, {
    id: existing.id,
    automaticAppDiscount: automaticDiscountInput({ activateNow: discount.status !== "ACTIVE" }),
  });
  const payload = data.discountAutomaticAppUpdate;
  if (payload.userErrors?.length) throw new Error(formatUserErrors(payload.userErrors));
  if (!payload.automaticAppDiscount) throw new Error("Shopify did not return the updated Vedant Coins discount.");

  console.info("[vedant-coins-discount] automatic discount reconciled", {
    discountId: payload.automaticAppDiscount.discountId,
    functionId: payload.automaticAppDiscount.appDiscountType.functionId,
  });
  return resultFor(payload.automaticAppDiscount, { updated: true });
}
