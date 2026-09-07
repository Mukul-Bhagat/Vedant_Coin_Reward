import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

function run(coins, subtotal) {
  return cartLinesDiscountsGenerateRun({
    cart: {
      buyerIdentity: {
        isAuthenticated: true,
        customer: { id: "gid://shopify/Customer/9709033750700" },
      },
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

  test("fails closed without an authenticated customer", () => {
    expect(cartLinesDiscountsGenerateRun({
      cart: {
        attribute: { key: "_vedant_coin_discount", value: "50" },
        buyerIdentity: { isAuthenticated: false, customer: null },
        cost: { subtotalAmount: { amount: "500" } },
      },
    })).toEqual({ operations: [] });
  });

  test("rejects malformed attribute payloads", () => {
    expect(run("50.5", 500)).toEqual({ operations: [] });
    expect(run("50coins", 500)).toEqual({ operations: [] });
  });
});
