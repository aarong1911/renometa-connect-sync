// netlify/functions/lib/test-support/fake-nodemailer-loader.mjs
//
// A Node.js module customization hook (module.register()) that redirects
// the bare "nodemailer" specifier to fake-nodemailer.mjs for the lifetime
// of the registering process. Needed because esbuild's own `alias` option
// INLINES the aliased module into the bundle — producing a second, private
// copy of fake-nodemailer.mjs's module state, disconnected from the copy a
// test imports directly to make assertions. A process-wide resolution hook
// keeps both the bundled subject-under-test and the test file itself
// resolving to the exact same module instance, so assertions on
// fakeMailer.sentMessages actually see what the bundle just did.

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "nodemailer") {
    return {
      url: new URL("./fake-nodemailer.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
