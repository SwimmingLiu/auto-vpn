export default {
  async fetch(request) {
    const MainData = `__MAIN_DATA__`;
    return new Response(MainData);
  }
};
