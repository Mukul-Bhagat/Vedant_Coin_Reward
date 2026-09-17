-- Preserve temporary reservations after order creation so redemption can be
-- tied to exactly one Shopify order and released idempotently on cancellation.
ALTER TABLE "CoinReservation"
ADD COLUMN "orderId" TEXT,
ADD COLUMN "orderName" TEXT,
ADD COLUMN "committedAt" TIMESTAMP(3),
ADD COLUMN "releasedAt" TIMESTAMP(3);

-- Rename lifecycle states without changing historical CoinTransaction records.
UPDATE "CoinReservation"
SET "status" = 'COMMITTED', "committedAt" = "updatedAt"
WHERE "status" = 'COMPLETED';

UPDATE "CoinReservation"
SET "status" = 'RELEASED', "releasedAt" = "updatedAt"
WHERE "status" = 'CANCELLED';

-- PostgreSQL permits multiple NULL values in this compound unique index, so
-- abandoned carts may continue to have no order ID while an order can claim
-- only one reservation within a shop.
CREATE UNIQUE INDEX "CoinReservation_shop_orderId_key"
ON "CoinReservation"("shop", "orderId");
