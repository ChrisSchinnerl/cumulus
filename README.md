# Sia Starter

Build private, encrypted storage apps on the [Sia](https://sia.tech) network. Data is end-to-end encrypted in the browser and transferred directly to and from Sia hosts — no proxies, gateways, or portals. Nobody but the user can see their data.

## Quick Start

```bash
bun install
bun dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Why Sia

- **Private by default** — All data is encrypted client-side before it leaves the browser. Encryption keys are derived from the user's recovery phrase and never shared.
- **Direct host connections** — Uploads and downloads happen directly between the browser and Sia hosts over WebTransport. There is no middleman that can see or intercept data.
- **No trusted third parties** — The indexer service handles payments and trustlessly repairs data so your app doesn't need to run 24/7, but it never sees the encrypted data shards. It can't read, modify, or withhold your files.
- **Erasure coded** — Data is split into redundant shards across many hosts. Files survive even if individual hosts go offline.
- **Decentralized** — Storage is provided by a global network of independent hosts competing on price and performance.

## What This Template Includes

- **Full auth flow** — connect to an indexer, approve the connection, set up a recovery phrase
- **File upload** — drag & drop files, track upload progress, list uploaded files
- **Sia SDK** — handles encryption, erasure coding, and direct host transfers in the browser
- **Developer notes** — amber callout boxes throughout the UI explaining how everything works (remove them when you ship)

## How It Works

### Architecture

```
Browser (your app)
  ├── encrypts data client-side
  ├── erasure codes into shards
  └── uploads/downloads shards directly to/from Sia hosts (WebTransport)

Indexer service
  ├── manages payments to hosts
  ├── tracks which hosts store which shards
  └── repairs data if hosts go offline
  └── cannot see encrypted data
```

### Auth Flow

1. **Connect** — Enter an indexer URL (default: `https://sia.storage`). The app sends your app metadata to request a connection.
2. **Approve** — Visit the approval URL in another tab to authorize your app.
3. **Recovery Phrase** — Generate a new 12-word phrase or enter an existing one. This deterministically derives all cryptographic keys.
4. **Connected** — The SDK is ready. Your app key is saved to localStorage for future sessions.

### Upload Flow

Files are encrypted in the browser, erasure coded into shards, and streamed directly to Sia hosts. The SDK handles all of this — your code just calls `sdk.upload(object, file.stream(), { onShardUploaded })`. Metadata (filename, type, size) is also encrypted and pinned to the indexer.

## Customization

### App Key & Metadata

Edit `src/lib/constants.ts` to set your app key, name, description, and indexer URL.

### Replace the Upload UI

The main post-auth component is `src/components/upload/UploadZone.tsx`. Replace it with your own UI — the SDK is available via:

```tsx
const sdk = useAuthStore((s) => s.sdk)
```

## Tech Stack

- [React](https://react.dev) 19
- [TypeScript](https://www.typescriptlang.org)
- [Vite](https://vite.dev)
- [Tailwind CSS](https://tailwindcss.com) 4
- [Zustand](https://zustand.docs.pmnd.rs) (state management)
- [Biome](https://biomejs.dev) (linting & formatting)
- [@siafoundation/sia-storage](https://www.npmjs.com/package/@siafoundation/sia-storage) (Sia SDK — encryption, erasure coding, direct host transfers via WASM)

## Project Structure

```
src/
├── lib/            # Constants, utilities
├── stores/         # Zustand stores (auth + toast)
├── types/          # Ambient type declarations (TC39 Uint8Array.toHex/fromHex)
└── components/
    ├── auth/       # Auth flow screens
    ├── upload/     # Upload dropzone
    └── DevNote.tsx # Developer callout (remove in production)
```

## Learn More

- [Sia Documentation](https://docs.sia.tech)
- [@siafoundation/sia-storage](https://www.npmjs.com/package/@siafoundation/sia-storage)
