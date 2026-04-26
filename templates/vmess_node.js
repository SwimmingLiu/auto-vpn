const MainData = `__MAIN_DATA__`;

async function handleRequest(request) {
  try {
    const url_tag = new URL(request.url).searchParams.get("serect_key");
    let req_data = "";
    if (url_tag === "swimmingliu") {
      req_data = MainData;
    } else {
      const bytes = new Uint8Array(Math.floor(Math.random() * 100));
      crypto.getRandomValues(bytes);
      req_data = String.fromCharCode.apply(null, bytes);
    }
    return new Response(btoa(req_data));
  } catch (err) {
    console.log(err);
    return new Response(err.toString());
  }
}

export default {
  async fetch(request) {
    return handleRequest(request);
  },
};
