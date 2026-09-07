import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const shop = "vedant-development-store.myshopify.com";
const customerId = "9709033750700";
try {
  console.log("\n--- BALANCE ---");
  console.log(
    await prisma.customerCoinBalance.findUnique({
      where: {
        shop_customerId: {
          shop,
          customerId,
        },
      },
    }),
  );
  console.log("\n--- RESERVATIONS ---");
  console.log(
    await prisma.coinReservation.findMany({
      where: {
        shop,
        customerId,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
  );
  console.log("\n--- TRANSACTIONS ---");
  console.log(
    await prisma.coinTransaction.findMany({
      where: {
        shop,
        customerId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    }),
  );
} finally {
  await prisma.$disconnect();
}
