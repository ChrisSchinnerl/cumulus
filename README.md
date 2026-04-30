# cumulus

A social filesharing app where your files live on [Sia](https://sia.tech) (encrypted, decentralized storage) and your social graph is your existing [Bluesky](https://bsky.app) one.

**Live demo: [cumulus.schinnerl.dev](https://cumulus.schinnerl.dev)**

Drop a file or folder → it's encrypted client-side, stored on the Sia network,
and a record pointing at it is written to your atproto repo. Anyone who follows
you on Bluesky sees it appear in their cumulus feed.

Why is this cool? Because you can share files with your existing social graph
without a new indexing service. The original author is acknowledged and anyone
can contribute to keeping files around by saving them to their own indexer.

## Run it locally

```bash
bun install
bun dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite is pinned to the IPv4 loopback because atproto OAuth's loopback profile rejects `localhost` origins.

First run, you'll go through:
1. **Sia connect** — enter an indexer URL (default works), approve the connection in the popup tab, generate or import a 12-word recovery phrase
2. **Bluesky sign-in** — type a handle (`alice.bsky.social`) or an email (routes through `bsky.social` since there's no public email→PDS lookup), authorize on Bluesky's OAuth page

## Features

- **Sign in with atproto** (handle or Bluesky email) and connect to a Sia indexer for storage.
- **Drop files or whole folders** onto the dropzone for uploading. Each file will be a separate post in your feed.
- **Tag everything** before upload to make it searchable.
- **Auto-detection** recognizes common conventions for shows/movies and pulls out show name / season / episode / title for tagging.
- **Following feed** shows shares from everyone you follow on Bluesky, sorted newest-first.
- **Library** shows your own posts and saves.
- **Save** any post in your Following feed to repin its file onto your own indexer and post a copy to your repo. Save propagates the original `sourceUri` so credit traces back to the first creator no matter how many hops the chain takes.
- **Live updates** via [Jetstream](https://docs.bsky.app/blog/jetstream): new posts and deletes from people you follow appear without a refresh.
- **Search** with `key:value` syntax (`type:tvshow season:1`), free-text, or `-key:value` exclusions.
- **Inline previews** — image thumbnails, video poster frames. Clicking an image opens a fullscreen lightbox; clicking a video plays it if the format is supported by your browser.
- **Click any handle** to open an in-app profile for that user, or click the Bluesky logo next to it to jump out to bsky.app.
