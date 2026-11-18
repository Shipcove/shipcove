// Recette : disposition du nœud Garage, clé S3 et buckets de la plateforme (idempotent).
const ADMIN = process.env.GARAGE_ADMIN_URL;
const h = { Authorization: `Bearer ${process.env.GARAGE_ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const r = await fetch(`${ADMIN}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
for (let i = 0; ; i++) {
  try {
    if ((await call('GET', '/v2/GetClusterStatus')).status === 200) break;
  } catch {}
  if (i > 60) throw new Error('Garage injoignable');
  await sleep(2000);
}
const { json: layout } = await call('GET', '/v2/GetClusterLayout');
if (!layout.roles?.length) {
  const { json: st } = await call('GET', '/v2/GetClusterStatus');
  await call('POST', '/v2/UpdateClusterLayout', { roles: [{ id: st.nodes[0].id, zone: 'dc1', capacity: 20 * 1024 ** 3, tags: [] }] });
  const { json: staged } = await call('GET', '/v2/GetClusterLayout');
  await call('POST', '/v2/ApplyClusterLayout', { version: staged.version + 1 });
  console.log('layout appliqué');
}
if ((await call('GET', `/v2/GetKeyInfo?id=${accessKeyId}`)).status !== 200) {
  await call('POST', '/v2/ImportKey', { accessKeyId, secretAccessKey, name: 'shipcove' });
  console.log('clé importée');
}
for (const bucket of ['cap-workspaces', 'cap-attachments']) {
  let { status, json } = await call('GET', `/v2/GetBucketInfo?globalAlias=${bucket}`);
  if (status !== 200) ({ json } = await call('POST', '/v2/CreateBucket', { globalAlias: bucket }));
  await call('POST', '/v2/AllowBucketKey', { bucketId: json.id, accessKeyId, permissions: { read: true, write: true, owner: false } });
}
console.log('Garage prêt');
