# Sia Starter — AI Assistant Guide

## Overview

A starter template for building decentralized storage apps on the Sia network. Uses [`@siafoundation/sia-storage`](https://www.npmjs.com/package/@siafoundation/sia-storage) — a TypeScript SDK that ships a pre-compiled WASM binary for encryption, uploads, downloads, and key management. WASM runs on the main thread (Rust async — no workers required).

**Tech stack:** React 19, TypeScript, Vite, Tailwind CSS 4, Zustand, `@siafoundation/sia-storage`

## Architecture

### Auth Flow State Machine

The app uses a step-based auth flow managed by Zustand (`src/stores/auth.ts`):

```
loading → connect → approve → recovery → connected
```

- **loading**: WASM initializes, checks for stored app key
- **connect**: User enters indexer URL, app constructs a `Builder` and calls `requestConnection()`
- **approve**: User visits approval URL in another tab; app polls `builder.waitForApproval()`
- **recovery**: User generates or enters a 12-word BIP-39 recovery phrase; `builder.register(phrase)` returns the `Sdk`
- **connected**: `Sdk` is ready, main app UI renders

### Returning users

Returning users skip `requestConnection`/`waitForApproval`/`register` entirely. `AuthFlow` constructs a `Builder` and calls `builder.connected(appKey)` with the persisted key — it returns an `Sdk` if the key is still valid, or `undefined` to fall back to the `connect` step.

### SDK

`@siafoundation/sia-storage` handles:
- Encrypted file uploads/downloads (erasure coding + encryption)
- Key derivation from recovery phrases (BIP-39)
- Object pinning and metadata management
- Connection auth with indexers
- Direct streaming to/from Sia hosts (no worker pool needed)

### Zustand Persistence

Auth state persists to localStorage via Zustand's `persist` middleware. The storage key is `{app-name}-auth`. Persisted fields: `storedKeyHex`, `indexerUrl`. The app key is stored as hex via the TC39 `Uint8Array.prototype.toHex` method.

## Key Files

| File | Description |
|------|-------------|
| `src/lib/constants.ts` | App key, app name, indexer URL, app metadata (typed `AppMetadata`) |
| `src/stores/auth.ts` | Auth state machine (Zustand + persist), holds the `Sdk` |
| `src/stores/toast.ts` | Toast notification store (auto-dismiss) |
| `src/components/Navbar.tsx` | App navbar with title, public key, sign out |
| `src/components/Toast.tsx` | Toast overlay component |
| `src/components/CopyButton.tsx` | Copy-to-clipboard button with toast |
| `src/components/auth/AuthFlow.tsx` | Auth orchestrator — `initSia()`, returning-user reconnect via `Builder.connected` |
| `src/components/auth/ConnectScreen.tsx` | Indexer URL form; constructs `new Builder(url, APP_META)` and calls `requestConnection()` |
| `src/components/auth/ApproveScreen.tsx` | Approval polling (auto-polls on mount) |
| `src/components/auth/RecoveryScreen.tsx` | Recovery phrase generation/import; `builder.register(phrase)` → `Sdk` |
| `src/components/upload/UploadZone.tsx` | File upload/download dropzone + file list |
| `src/components/DevNote.tsx` | Developer callout component |
| `src/types/uint8array-hex.d.ts` | Ambient types for TC39 `Uint8Array.toHex`/`fromHex` (drop once TS lib ships them) |

## SDK Usage Patterns

### Upload a file

```ts
import { PinnedObject } from '@siafoundation/sia-storage'

const object = new PinnedObject()
const pinnedObject = await sdk.upload(object, file.stream(), {
  maxInflight: 10,
  onShardUploaded: (progress) => {
    // progress: { hostKey, shardSize, shardIndex, slabIndex, elapsedMs }
    console.log(`shard ${progress.shardIndex} uploaded (${progress.shardSize}b)`)
  },
})

pinnedObject.updateMetadata(new TextEncoder().encode(JSON.stringify({
  name: 'file.txt',
  type: 'text/plain',
  size: file.size,
  hash: '...',
})))
await sdk.pinObject(pinnedObject)
await sdk.updateObjectMetadata(pinnedObject)
```

### Download a file

`sdk.download` returns a `ReadableStream` of `Uint8Array` chunks. Buffer it, or stream it directly into a `Response`/`Blob`:

```ts
const stream = sdk.download(pinnedObject, {
  maxInflight: 10,
  onShardDownloaded: (progress) => {
    console.log(`shard ${progress.shardIndex} downloaded`)
  },
})
const blob = await new Response(stream).blob()
```

### List files

```ts
const events = await sdk.objectEvents(undefined, 100)
for (const event of events) {
  if (!event.deleted && event.object) {
    const meta = JSON.parse(new TextDecoder().decode(event.object.metadata()))
    console.log(meta.name, event.object.size())
  }
}
```

### Delete a file

```ts
await sdk.deleteObject(objectId)
```

### Share a file

```ts
const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
const shareUrl = sdk.shareObject(pinnedObject, validUntil)
```

### Download a shared file

```ts
const object = await sdk.sharedObject(shareUrl)
const stream = sdk.download(object)
```

## Customization

### Change app key

Edit `src/lib/constants.ts`. The app key is a 32-byte hex string that identifies your app to the indexer. Generate one with:

```ts
crypto.getRandomValues(new Uint8Array(32)).toHex()
```

### Replace the upload UI

The post-auth UI is rendered in `src/App.tsx`. Replace `<UploadZone />` with your own component. The `Sdk` is available via `useAuthStore((s) => s.sdk)`. All SDK methods live directly on `Sdk` — `sdk.upload()`, `sdk.download()`, `sdk.objectEvents()`, etc.

### Add routes

Install `react-router-dom` and wrap your app. The auth flow should gate all routes.

## Common Commands

```bash
bun install     # Install dependencies
bun dev         # Start dev server
bun run build   # Production build
bun run check   # Lint with Biome
```
