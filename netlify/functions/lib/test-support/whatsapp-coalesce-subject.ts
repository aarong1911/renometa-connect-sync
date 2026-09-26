// Bundling entry for meta-whatsapp-coalesce.test.ts. The code under test
// imports src/ modules that use the "@/" alias, so the test bundles this file
// with esbuild instead of relying on Node's native type stripping.
export { processWhatsAppBackground } from "../meta-whatsapp-background";
export * from "../meta-whatsapp-coalesce";
export { approveRequest, rejectRequest, hashProposedInput } from "../../../../src/lib/agentic/approvals";
export * from "../meta-whatsapp-claim";
