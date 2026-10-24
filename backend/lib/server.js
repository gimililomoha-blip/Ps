import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const app = Fastify({ logger: true });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.JWT_SECRET || 'change-this-secret' });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Manager'
    );
    CREATE TABLE IF NOT EXISTS stores (
      id BIGSERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id BIGSERIAL PRIMARY KEY,
      model TEXT NOT NULL,
      imei TEXT UNIQUE NOT NULL,
      store_id BIGINT NOT NULL REFERENCES stores(id),
      price NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'inStock'
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id BIGSERIAL PRIMARY KEY,
      from_store_id BIGINT NOT NULL REFERENCES stores(id),
      to_store_id BIGINT NOT NULL REFERENCES stores(id),
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transfer_devices (
      transfer_id BIGINT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
      device_id BIGINT NOT NULL REFERENCES devices(id),
      PRIMARY KEY (transfer_id, device_id)
    );
  `);
}

const auth = async (req, rep) => {
  try { await req.jwtVerify(); }
  catch { return rep.code(401).send({ error: 'Unauthorized' }); }
};

app.get('/api/health', async () => ({ ok: true, service: 'PhoneShop backend' }));

app.post('/api/auth/register', async (req, rep) => {
  const { email, password, role = 'Manager' } = req.body || {};
  if (!email || !password) return rep.code(400).send({ error: 'email and password required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query('INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) RETURNING id', [email, hash, role]);
    return { token: app.jwt.sign({ id: r.rows[0].id, email, role }) };
  } catch { return rep.code(409).send({ error: 'email already exists' }); }
});

app.post('/api/auth/login', async (req, rep) => {
  const { email, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) return rep.code(401).send({ error: 'invalid credentials' });
  return { token: app.jwt.sign({ id: u.id, email: u.email, role: u.role }) };
});

app.get('/api/stores', { preHandler: auth }, async () => (await pool.query('SELECT * FROM stores ORDER BY name')).rows);
app.post('/api/stores', { preHandler: auth }, async (req, rep) => {
  try {
    const r = await pool.query('INSERT INTO stores(name) VALUES($1) RETURNING id,name', [req.body.name]);
    return rep.code(201).send(r.rows[0]);
  } catch { return rep.code(409).send({ error: 'store already exists' }); }
});

app.get('/api/devices', { preHandler: auth }, async () => (await pool.query('SELECT d.*,s.name AS store FROM devices d JOIN stores s ON s.id=d.store_id ORDER BY d.id DESC')).rows);
app.post('/api/devices', { preHandler: auth }, async (req, rep) => {
  const { model, imei, store_id, price = 0, status = 'inStock' } = req.body || {};
  if (!/^\d{15}$/.test(String(imei))) return rep.code(400).send({ error: 'IMEI must contain exactly 15 digits' });
  try {
    const r = await pool.query('INSERT INTO devices(model,imei,store_id,price,status) VALUES($1,$2,$3,$4,$5) RETURNING id', [model, imei, store_id, price, status]);
    return rep.code(201).send(r.rows[0]);
  } catch { return rep.code(409).send({ error: 'IMEI already exists or store is invalid' }); }
});

app.get('/api/transfers', { preHandler: auth }, async () => (await pool.query(`SELECT t.*, STRING_AGG(d.imei, ',') AS imeis FROM transfers t LEFT JOIN transfer_devices td ON td.transfer_id=t.id LEFT JOIN devices d ON d.id=td.device_id GROUP BY t.id ORDER BY t.id DESC`)).rows);

app.post('/api/transfers', { preHandler: auth }, async (req, rep) => {
  const { imeis, from_store_id, to_store_id } = req.body || {};
  if (!Array.isArray(imeis) || !imeis.length || from_store_id === to_store_id) return rep.code(400).send({ error: 'valid IMEIs and different stores required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const placeholders = imeis.map((_, i) => `$${i + 1}`).join(',');
    const ds = await client.query(`SELECT * FROM devices WHERE imei IN (${placeholders}) AND store_id=$${imeis.length + 1} AND status='inStock' FOR UPDATE`, [...imeis, from_store_id]);
    if (ds.rows.length !== imeis.length) { await client.query('ROLLBACK'); return rep.code(400).send({ error: 'one or more IMEIs are unavailable' }); }
    const t = await client.query('INSERT INTO transfers(from_store_id,to_store_id) VALUES($1,$2) RETURNING id', [from_store_id, to_store_id]);
    for (const d of ds.rows) await client.query('INSERT INTO transfer_devices(transfer_id,device_id) VALUES($1,$2)', [t.rows[0].id, d.id]);
    await client.query('COMMIT');
    return rep.code(201).send(t.rows[0]);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
});

app.post('/api/transfers/:id/complete', { preHandler: auth }, async (req, rep) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM transfers WHERE id=$1 FOR UPDATE', [req.params.id]);
    const t = r.rows[0];
    if (!t || t.status !== 'Pending') { await client.query('ROLLBACK'); return rep.code(400).send({ error: 'transfer is not pending' }); }
    await client.query('UPDATE devices SET store_id=$1 WHERE id IN (SELECT device_id FROM transfer_devices WHERE transfer_id=$2)', [t.to_store_id, t.id]);
    await client.query("UPDATE transfers SET status='Completed' WHERE id=$1", [t.id]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
});

app.post('/api/transfers/:id/cancel', { preHandler: auth }, async (req) => {
  await pool.query("UPDATE transfers SET status='Cancelled' WHERE id=$1 AND status='Pending'", [req.params.id]);
  return { ok: true };
});

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
await initDb();

// Vercel serverless entrypoint: export the Fastify handler.
// Local/Render execution still starts an HTTP listener.
export default async function handler(req, res) {
  await app.ready();
  app.server.emit('request', req, res);
}

if (!process.env.VERCEL) {
  await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
}
