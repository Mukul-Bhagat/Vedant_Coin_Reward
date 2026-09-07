// Shopify's development proxy can forward the configured /apps/coins path directly.
// Reuse the canonical app-proxy loader so authentication and balance logic stay centralized.
export { loader } from "./app-proxy";
