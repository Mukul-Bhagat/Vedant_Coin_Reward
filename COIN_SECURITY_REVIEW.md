# Vedant Coins Security Review

## Finding

`_vedant_coin_discount` is a customer-editable Shopify cart attribute. The current Discount Function input can read that attribute and the merchandise subtotal, but it cannot query Prisma, receive a cart ID, or make a backend request on the development store. A numeric attribute must therefore not be treated as proof of ownership.

The current development Function is intentionally preserved because the proven automatic discount must not be broken before its replacement is available.

## Implemented backend boundary

`app/services/coin-authorization.server.js` provides the authorization decision that a secure Function integration must use. It requires:

- shop and authenticated customer identity
- the reservation cart token
- the exact reserved integer amount
- merchandise subtotal, excluding shipping and tax
- an unexpired ACTIVE reservation owned by that customer

It fails closed for missing identity, invalid amounts, mismatches, expired reservations, foreign customers, and amounts above merchandise subtotal.

## Shopify-compatible production architecture

For an enterprise custom app, use Shopify Discount Function network access:

1. The theme reserves coins through the backend.
2. The backend returns a non-secret reservation reference and the theme writes it with the requested amount to cart attributes.
3. The Discount Function `cart.lines.discounts.generate.fetch` sends the customer ID, reservation reference, requested amount, and merchandise subtotal to a backend HTTPS endpoint.
4. The backend verifies Shopify's Function request JWT, calls `authorizeCoinDiscount`, and returns an order-discount operation only when authorization succeeds.
5. The run target consumes only `fetchResult`; it returns no operation for any non-200, missing, expired, mismatched, or malformed response.
6. The paid-order webhook commits the same reservation using the Shopify order cart token. Refund and cancellation handlers continue to reconcile the ledger.

The endpoint must validate Shopify's `x-shopify-request-jwt` claims, including signature, issuer shop, method, URL, body hash, and request ID. The server secret must remain in the app environment and never reach theme JavaScript or the Function input.

Shopify currently documents Discount Function network access as enterprise-only and unavailable on development stores. Therefore fetch targets are not activated in this development project: doing so would disable the currently working development discount rather than secure it.

## Required activation gate

Before production:

- obtain Shopify network-access eligibility for the target store
- add the fetch targets and `fetchResult` input queries
- add the JWT-verified HTTPS authorization endpoint
- switch the run target to fail closed on the authorization response
- test cart/customer/amount mismatch, replay, expiry, cart changes, payment success, cancellation, refunds, and duplicate webhooks on the eligible store
- remove the legacy numeric-attribute fallback only after the secure path is proven

Until that gate is complete, arbitrary cart-attribute manipulation remains a production blocker.
