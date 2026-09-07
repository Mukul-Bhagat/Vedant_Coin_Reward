import { OrderDiscountSelectionStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Applies Vedant Coins as an order-level fixed discount.
 *
 * 1 coin = ₹1.
 *
 * The storefront writes the selected coin amount into:
 * _vedant_coin_discount
 *
 * The Function independently clamps the discount to the cart subtotal.
 *
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const buyerIdentity = input.cart?.buyerIdentity;
  if (!buyerIdentity?.isAuthenticated || !buyerIdentity.customer?.id) {
    return {
      operations: [],
    };
  }

  const rawCoins = input.cart?.attribute?.value ?? "0";

  if (typeof rawCoins !== "string" || !/^\d+$/.test(rawCoins.trim())) {
    return {
      operations: [],
    };
  }

  const requestedCoins = Number(rawCoins);

  if (!Number.isFinite(requestedCoins) || requestedCoins <= 0) {
    return {
      operations: [],
    };
  }

  const subtotal = Number(
    input.cart?.cost?.subtotalAmount?.amount ?? 0,
  );

  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    return {
      operations: [],
    };
  }

  // 1 coin = ₹1.
  // Never allow the coin discount to exceed the cart subtotal.
  const discountAmount = Math.min(requestedCoins, subtotal);

  if (discountAmount <= 0) {
    return {
      operations: [],
    };
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: "Vedant Coins",
              value: {
                fixedAmount: {
                  amount: discountAmount.toFixed(2),
                },
              },
              targets: [
                {
                  orderSubtotal: {
                    excludedCartLineIds: [],
                  },
                },
              ],
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
