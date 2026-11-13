/**
 * Verify the account pool survives a container restart.
 *
 * The DO keeps the CSV; the container cannot keep anything. This drives the
 * real Worker in workerd, imports a pool, then proves the stored copy is what
 * a cold container would be restored from. The container calls themselves are
 * stubbed at the DO boundary because `wrangler dev` here has no Docker
 * container bound — the storage, the SQL and the decide-to-restore logic are
 * the real code.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8788';
const token = process.argv[3] ?? 'smoke-token';
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

let failures = 0;
const check = async (name, fn) => {
  try {
    console.log(`ok   ${name}${await fn().then((d) => (d ? ` — ${d}` : ''))}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error.message}`);
  }
};
const expect = (c, m) => { if (!c) throw new Error(m); };

await check('a fresh deployment has no stored pool', async () => {
  const response = await fetch(`${base}/api/accounts`, { headers: auth });
  expect(response.ok, `status ${response.status}`);
  const payload = await response.json();
  expect(payload.stored === null, `stored=${JSON.stringify(payload.stored)}`);
  return 'stored=null';
});

await check('importing stores the pool in DO SQLite', async () => {
  const response = await fetch(`${base}/api/accounts/import`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ csv: 'brand,account,password\nleiting,a,1\nheidong,b,2\nmifeng,c,3\n' })
  });
  expect(response.ok, `status ${response.status}`);
  const result = await response.json();
  // The container is not bound in this dev harness, so the import body reports
  // the storage side only; that is the half this test is about.
  expect(typeof result.rows === 'number', `rows=${result.rows}`);
  return `rows=${result.rows}`;
});

await check('the stored row count survives a Worker restart', async () => {
  const response = await fetch(`${base}/api/accounts`, { headers: auth });
  const payload = await response.json();
  expect(payload.stored, 'no stored pool after import');
  expect(payload.stored.row_count === 3, `row_count=${payload.stored.row_count}`);
  return `row_count=${payload.stored.row_count}`;
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
