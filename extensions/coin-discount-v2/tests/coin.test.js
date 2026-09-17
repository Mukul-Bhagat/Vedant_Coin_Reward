import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

function run(coins, subtotal, buyerIdentity) {
  return cartLinesDiscountsGenerateRun({
    cart: {
      ...(buyerIdentity === undefined ? {} : { buyerIdentity }),
      attribute: {
        key: "_vedant_coin_discount",
        value: String(coins),
      },
      cost: {
        subtotalAmount: {
          amount: String(subtotal),
        },
      },
    },
  });
}

describe("Vedant Coins discount Function", () => {
  test.each([
    [50, 1499.9, "50.00"],
    [1000, 500, "500.00"],
    [1000, 200, "200.00"],
    [300, 500, "300.00"],
  ])("clamps %i requested coins to a %s subtotal", (coins, subtotal, amount) => {
    const result = run(coins, subtotal);
    expect(result.operations[0].orderDiscountsAdd.candidates[0].value.fixedAmount.amount).toBe(amount);
  });

  test.each([
    [0, 500],
    [-1, 500],
    [50, 0],
  ])("returns no discount for invalid input %i / %s", (coins, subtotal) => {
    expect(run(coins, subtotal)).toEqual({ operations: [] });
  });

  test("applies a ₹100 order discount to a ₹500 cart without a buyer identity", () => {
    expect(run(100, 500)).toEqual({
      operations: [
        {
          orderDiscountsAdd: {
            candidates: [
              {
                message: "Vedant Coins",
                value: { fixedAmount: { amount: "100.00" } },
                targets: [
                  { orderSubtotal: { excludedCartLineIds: [] } },
                ],
              },
            ],
            selectionStrategy: "FIRST",
          },
        },
      ],
    });
  });

  test("applies the cart-attribute discount for an unauthenticated buyer", () => {
    const anonymousBuyer = { isAuthenticated: false, customer: null };
    expect(run(100, 500, anonymousBuyer)).toEqual(run(100, 500));
  });

  test("rejects malformed attribute payloads", () => {
    expect(run("50.5", 500)).toEqual({ operations: [] });
    expect(run("50coins", 500)).toEqual({ operations: [] });
  });
});
