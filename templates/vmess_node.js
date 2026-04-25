const MainData = ``;

addEventListener('fetch', (event) => {
  event.respondWith(
    new Response(MainData, {
      headers: {
        'content-type': 'text/plain; charset=utf-8'
      }
    })
  );
});
