import { bindings, defineGadgetsWorker } from "@gadgets/scripts/worker-config";

/**
 * Test-only stand-in for Cloudflare Email Routing, which the test harness cannot dispatch: it hands
 * a parsed IncomingEmail straight to gatekeeper-email's per-address Durable Object, the same call
 * gatekeeper-email's email() handler makes after parsing. The binding reaches gatekeeper-email's
 * class the way fixtures/gatekeeper-test reaches the Workshop's Overseer.
 */
export default defineGadgetsWorker({
  name: "blos-email-sender",
  entrypoint: "src/blos-email-sender.ts",
  env: {
    EMAIL_ADDRESS: bindings.durableObject({ worker: "gatekeeper-email", exportName: "EmailAddress" }),
  },
});
