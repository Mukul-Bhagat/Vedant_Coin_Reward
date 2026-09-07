export function isCashOnDeliveryOrder(order) {
  const gateways = [
    order?.gateway,
    ...(Array.isArray(order?.payment_gateway_names)
      ? order.payment_gateway_names
      : []),
  ]
    .filter(Boolean)
    .map((gateway) => String(gateway).trim().toLowerCase());

  return gateways.some(
    (gateway) => gateway.includes("cash on delivery") || /\bcod\b/.test(gateway),
  );
}
