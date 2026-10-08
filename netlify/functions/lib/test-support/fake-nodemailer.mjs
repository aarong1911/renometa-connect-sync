// netlify/functions/lib/test-support/fake-nodemailer.mjs
//
// A minimal in-memory stand-in for the "nodemailer" package, used ONLY in
// tests (via esbuild's `alias` option) to exercise appointment-post-
// booking.ts's confirmation-email branch without ever opening a real
// socket to smtp.gmail.com. Records every call so a test can assert on
// send count/content without any real network access.

export const sentMessages = [];
export let createTransportCalls = 0;

export function __reset() {
  sentMessages.length = 0;
  createTransportCalls = 0;
}

function createTransport(_opts) {
  createTransportCalls += 1;
  return {
    async sendMail(message) {
      sentMessages.push(message);
      return { messageId: `fake-${sentMessages.length}` };
    },
    close() {},
  };
}

export default { createTransport };
