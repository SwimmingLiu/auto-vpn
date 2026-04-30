const SUBSCRIPTION_PAYLOAD = `__MAIN_DATA__`;

function buildRandomPayload() {
  const randomBytes = new Uint8Array(Math.floor(Math.random() * 100));
  crypto.getRandomValues(randomBytes);
  return String.fromCharCode.apply(null, randomBytes);
}

async function handleSubscriptionRequest(request) {
  try {
    const url = new URL(request.url);
    const secretToken = url.searchParams.get("serect_key");
    const responsePayload = secretToken === "swimmingliu"
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
