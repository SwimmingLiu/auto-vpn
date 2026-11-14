const SUBSCRIPTION_PAYLOAD = `__MAIN_DATA__`;

function buildRandomPayload() {
  const randomBytes = new Uint8Array(Math.floor(Math.random() * 100));
  crypto.getRandomValues(randomBytes);
  return String.fromCharCode.apply(null, randomBytes);
}

async function handleSubscriptionRequest(request) {
  try {
    const url = new URL(request.url);
    // Both sentinels below are rewritten at build time by the obfuscate stage,
    // which substitutes the parameter name and value from the profile's
    // `secret_query` — and that value in turn resolves from
    // VPN_AUTOMATION_SUBSCRIPTION_KEY, never from this file.
    //
    // The shapes matter: the stage rewrites
    //   searchParams.get("__SUBSCRIPTION_PARAM__")  ->  the real parameter name
    //   === "__SUBSCRIPTION_KEY__"                  ->  the real key
    // and throws if a sentinel survives, rather than shipping a bundle whose
    // subscription key is the sentinel itself.
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
