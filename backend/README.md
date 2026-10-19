# PhoneShop Backend

Persistent Node.js/Fastify/SQLite API for users, stores, IMEI inventory, and transfers.

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Health check: `GET http://localhost:3000/api/health`.
Use JWT from `/api/auth/register` or `/api/auth/login` as `Authorization: Bearer <token>`.
