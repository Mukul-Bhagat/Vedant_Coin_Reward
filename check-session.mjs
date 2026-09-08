import prisma from "./app/db.server.js";
const rows = await prisma.session.findMany({
  where: { shop: "vedantenterprise.myshopify.com" },
  select: {
    id: true,
    shop: true,
    isOnline: true,
    expires: true,
    scope: true,
  },
});
console.log(rows);
await prisma.$disconnect();
