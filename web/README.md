# Prime Port web

Freelancer-facing app for browsing jobs, claiming private ports, and continuing job chats.

This app is the issue #9 interface implementation: job board plus WhatsApp-style chat navigation.
The chat is intentionally its own full-screen route, not a chat box embedded inside a job detail
page.

## What This Covers

- Premium standalone landing page at `/`.
- Freelancer dashboard at `/home`.
- Open job board at `/jobs`.
- Canonical job detail route at `/jobs/:jobId` for social deep links.
- Claim flow that posts to the real backend claim endpoint.
- Claimed-port list at `/chats`.
- Full-screen private chat route at `/chats/:jobId`.
- Mobile-first dark command-interface design inspired by the project direction.

## Integration Notes

- The app uses `GET /jobs` and `POST /jobs/:jobId/claims` from `backend/mcp-server`.
- The Vite dev server proxies `/api` to `http://localhost:8792`.
- `src/api.ts` owns the REST client.
- `src/identity.ts` is the temporary local identity adapter until the embedded wallet provider is chosen.
- `src/storage.ts` is the temporary local chat/claim adapter until browser XMTP messaging is wired in.

## Routes

| Route | Purpose |
|---|---|
| `/` | Public landing page |
| `/home` | Freelancer dashboard |
| `/jobs` | Job board |
| `/jobs/:jobId` | Direct job detail page |
| `/chats` | WhatsApp-style claimed-port list |
| `/chats/:jobId` | Full-screen private port chat |

## Run Locally

Start the backend REST surface:

```powershell
cd backend\mcp-server
npm install
npm start
```

Run the web app:

```powershell
cd web
npm install
npm run dev
```

Open:

```text
http://localhost:5173/
```

## Verify

```powershell
cd web
npm run build
```

Expected:

```text
tsc --noEmit && vite build
```

The build should complete without TypeScript or Vite errors.
