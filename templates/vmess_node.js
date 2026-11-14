const SUBSCRIPTION_PAYLOAD = `__MAIN_DATA__`;

function buildRandomPayload() {
  const randomBytes = new Uint8Array(Math.floor(Math.random() * 100));
  crypto.getRandomValues(randomBytes);
  return String.fromCharCode.apply(null, randomBytes);
}

async function handleSubscriptionRequest(request) {
  try {
    const url = new URL(request.url);
    // Two sentinels below are rewritten at build time by the obfuscate stage,
    // which substitutes the parameter name and the key value from the profile's
    // `secret_query` — and that value in turn resolves from
    // VPN_AUTOMATION_SUBSCRIPTION_KEY, never from this file.
    //
    // The shapes matter: the stage rewrites the `searchParams.get(...)` call and
    // the string comparison on the next line, and throws if a sentinel
    // survives, rather than shipping a bundle whose subscription key is the
    // sentinel itself. The comment deliberately does not repeat them verbatim:
    // an identical literal in prose is what a later editor copies and what a
    // naive parser reads back.
    const secretToken = url.searchParams.get("__SUBSCRIPTION_PARAM__");
    const responsePayload = secretToken === "__SUBSCRIPTION_KEY__"
      ? SUBSCRIPTION_PAYLOAD
      : buildRandomPayload();
    return new Response(btoa(responsePayload));
  } catch (error) {
    console.log(error);
    return new Response(error.toString());
  }
}

export default {
  async fetch(request) {
    return handleSubscriptionRequest(request);
  },
};
