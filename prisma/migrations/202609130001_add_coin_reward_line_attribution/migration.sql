-- Preserve the existing ledger while allowing new order rewards and reversals
-- to be attributed to an exact Shopify line item and quantity.
ALTER TABLE "CoinTransaction"
ADD COLUMN "lineItemId" TEXT,
ADD COLUMN "rewardQuantity" INTEGER;

CREATE INDEX "CoinTransaction_shop_orderId_lineItemId_idx"
ON "CoinTransaction"("shop", "orderId", "lineItemId");
