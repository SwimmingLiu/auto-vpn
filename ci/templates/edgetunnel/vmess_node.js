const MainData = `
`;

let globalCache = {};

async function handleRequest(request) {
  try {
    const urlTag = new URL(request.url).searchParams.get('serect_key');
    let reqData = '';
    if (urlTag === 'swimmingliu') {
      reqData = MainData;
    } else {
      const bytes = new Uint8Array(Math.floor(Math.random() * 100));
      crypto.getRandomValues(bytes);
      reqData = String.fromCharCode.apply(null, bytes);
    }
    return new Response(btoa(reqData));
  } catch (error) {
    return new Response(String(error));
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
