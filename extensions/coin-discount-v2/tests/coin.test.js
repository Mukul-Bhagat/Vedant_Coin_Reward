import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

function run({ coins, subtotal, buyerIdentity, reservationId, lines } = {}) {
  return cartLinesDiscountsGenerateRun({
    cart: {
      ...(buyerIdentity === undefined ? {} : { buyerIdentity }),
      ...(coins === undefined
        ? {}
        : {
            attribute: {
              key: "_vedant_coin_discount",
              value: String(coins),
            },
          }),
      // This is deliberately not read by the Function. Its lifecycle remains
      // owned by the app, while the monetary discount is driven by coinAttribute.
      ...(reservationId === undefined
        ? {}
        : {
            attributes: [
              {
                key: "_vedant_coin_reservation_id",
                value: String(reservationId),
              },
            ],
          }),
      cost: {
        subtotalAmount: {
          amount: String(subtotal),
        },
      },
      ...(lines === undefined ? {} : { lines }),
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
    const result = run({ coins, subtotal });
    expect(result.operations[0].orderDiscountsAdd.candidates[0].value.fixedAmount.amount).toBe(amount);
  });

  test("returns one ₹100 order-subtotal discount for a ₹699 cart", () => {
    expect(run({ coins: "100", subtotal: 699 })).toEqual({
      operations: [
        {
          orderDiscountsAdd: {
            candidates: [
              {
                message: "Vedant Coins",
                value: { fixedAmount: { amount: "100.00" } },
                targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              },
            ],
            selectionStrategy: "MAXIMUM",
          },
        },
      ],
    });
  });

  test("caps ₹100 coins to an ₹80 subtotal", () => {
    const result = run({ coins: "100", subtotal: 80 });
    expect(result.operations[0].orderDiscountsAdd.candidates[0].value.fixedAmount.amount).toBe("80.00");
  });

  test.each([
    ["0", 699],
    ["-100", 699],
    ["abc", 699],
    ["50.5", 699],
    ["50coins", 699],
    ["100", 0],
  ])("returns no operation for unusable input %s / %s", (coins, subtotal) => {
    expect(run({ coins, subtotal })).toEqual({ operations: [] });
  });

  test("returns no operation when the coin attribute is absent", () => {
    expect(run({ subtotal: 699 })).toEqual({ operations: [] });
  });

  test("does not require an authenticated buyer", () => {
    const anonymousBuyer = { isAuthenticated: false, customer: null };
    expect(run({ coins: 100, subtotal: 500, buyerIdentity: anonymousBuyer })).toEqual(
      run({ coins: 100, subtotal: 500 }),
    );
  });

  test("applies the amount once to the order regardless of cart-line quantity", () => {
    const result = run({
      coins: "100",
      subtotal: 699,
      lines: [{ id: "gid://shopify/CartLine/1", quantity: 7 }],
    });

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].orderDiscountsAdd.candidates).toHaveLength(1);
    expect(result.operations[0].orderDiscountsAdd.candidates[0]).toMatchObject({
      value: { fixedAmount: { amount: "100.00" } },
      targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
    });
  });

  test("applies when the existing reservation attribute is present", () => {
    const withReservation = run({
      coins: "100",
      subtotal: 699,
      reservationId: "reservation-123",
    });
    expect(withReservation).toEqual(run({ coins: "100", subtotal: 699 }));
  });
});
