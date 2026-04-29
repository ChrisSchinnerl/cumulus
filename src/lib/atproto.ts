import { Agent, AtUri } from '@atproto/api'
import {
  BrowserOAuthClient,
  buildAtprotoLoopbackClientMetadata,
  type OAuthSession,
} from '@atproto/oauth-client-browser'
import {
  isSharePost,
  NSID_SHARE_POST,
  type SharePost,
  type SharePostRecord,
} from './lexicons'

/**
 * Scopes requested at sign-in time and declared in the loopback client
 * metadata. `atproto` is the base scope; `transition:generic` is required to
 * write arbitrary records (e.g. `app.cumulus.share.post`) to the user's repo
 * via `com.atproto.repo.createRecord`.
 */
export const OAUTH_SCOPE = 'atproto transition:generic'

let client: BrowserOAuthClient | null = null

/**
 * Lazily construct (and memoize) the singleton {@link BrowserOAuthClient}.
 *
 * In dev we explicitly build the loopback client metadata so it declares
 * `transition:generic` — the default loopback profile only declares
 * `atproto`, which the OAuth server then refuses to grant beyond. Loopback
 * clients accept any `http://127.0.0.1:<port>` / `http://[::1]:<port>`
 * origin; the library auto-redirects from `localhost`. In production we'd
 * swap in a hosted client-metadata.json URL via `BrowserOAuthClient.load`.
 */
export function getOAuthClient(): BrowserOAuthClient {
  if (!client) {
    // The default redirect URIs for the loopback profile are `http://127.0.0.1/`
    // and `http://[::1]/` — both port 80, which is never where vite runs. Pass
    // the current origin explicitly so the OAuth server redirects back to the
    // dev port.
    const origin =
      window.location.hostname === 'localhost'
        ? `http://127.0.0.1:${window.location.port}`
        : window.location.origin
    client = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: buildAtprotoLoopbackClientMetadata({
        scope: OAUTH_SCOPE,
        redirect_uris: [`${origin}/`],
      }),
    })
  }
  return client
}

/** Build an authenticated {@link Agent} from an OAuth session. */
export function makeAgent(session: OAuthSession): Agent {
  return new Agent(session)
}

/**
 * Publish a `app.cumulus.share.post` record to the authenticated user's repo.
 * Returns the record's at:// URI + CID.
 *
 * `validate: false` — `app.cumulus.share.post` isn't a registered lexicon on
 * the PDS, so server-side schema validation must be skipped or the call 400s.
 */
export async function writeSharePost(
  agent: Agent,
  post: Omit<SharePost, '$type'>,
): Promise<{ uri: string; cid: string }> {
  const did = agent.assertDid
  const res = await agent.com.atproto.repo.createRecord({
    repo: did,
    collection: NSID_SHARE_POST,
    validate: false,
    record: { $type: NSID_SHARE_POST, ...post } satisfies SharePost,
  })
  return { uri: res.data.uri, cid: res.data.cid }
}

/**
 * Delete a share record from the authenticated user's repo. Idempotent — the
 * PDS returns success even if the record was already gone.
 *
 * @param atUri at:// URI of the record (e.g. as returned by `listSharePosts`).
 */
export async function deleteSharePost(
  agent: Agent,
  atUri: string,
): Promise<void> {
  const parsed = new AtUri(atUri)
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.host,
    collection: parsed.collection,
    rkey: parsed.rkey,
  })
}

const PDS_CACHE_KEY = 'cumulus:pds-cache'

/**
 * Hydrate the in-memory PDS cache from localStorage. DID→PDS mappings are
 * essentially immutable (they only change on PDS migration), so persisting
 * across reloads turns the second-and-subsequent feed loads into pure
 * `listRecords` calls with no plc.directory traffic.
 */
function loadPdsCache(): Map<string, string> {
  try {
    const raw = localStorage.getItem(PDS_CACHE_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, string>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

function savePdsCache(cache: Map<string, string>): void {
  try {
    localStorage.setItem(
      PDS_CACHE_KEY,
      JSON.stringify(Object.fromEntries(cache)),
    )
  } catch {
    // localStorage full / disabled — fall back to in-memory only.
  }
}

const pdsCache = loadPdsCache()

/**
 * Resolve a DID to its PDS endpoint URL via the public DID document.
 *
 * Supports `did:plc:*` (via plc.directory) and `did:web:*` (via the canonical
 * `/.well-known/did.json` location). Results are cached in-memory and
 * persisted to localStorage so subsequent page loads skip plc.directory.
 */
export async function resolvePds(did: string): Promise<string> {
  const cached = pdsCache.get(did)
  if (cached) return cached

  let docUrl: string
  if (did.startsWith('did:plc:')) {
    docUrl = `https://plc.directory/${did}`
  } else if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length))
    docUrl = `https://${host}/.well-known/did.json`
  } else {
    throw new Error(`Unsupported DID method: ${did}`)
  }

  const res = await fetch(docUrl)
  if (!res.ok) throw new Error(`DID resolve failed: ${res.status}`)
  const doc = (await res.json()) as {
    service?: Array<{ id: string; type: string; serviceEndpoint: string }>
  }
  const svc = doc.service?.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
  )
  if (!svc?.serviceEndpoint) {
    throw new Error(`No atproto PDS in DID document for ${did}`)
  }
  pdsCache.set(did, svc.serviceEndpoint)
  savePdsCache(pdsCache)
  return svc.serviceEndpoint
}

/**
 * List `app.cumulus.share.post` records from the given DID's repo.
 *
 * Unauthenticated — atproto repos are public. Records that fail the
 * {@link isSharePost} guard are silently skipped.
 */
export async function listSharePosts(
  did: string,
  limit = 20,
): Promise<SharePostRecord[]> {
  const pds = await resolvePds(did)
  const url = new URL('/xrpc/com.atproto.repo.listRecords', pds)
  url.searchParams.set('repo', did)
  url.searchParams.set('collection', NSID_SHARE_POST)
  url.searchParams.set('limit', String(limit))

  const res = await fetch(url)
  if (!res.ok) {
    if (res.status === 400) return []
    throw new Error(`listRecords failed for ${did}: ${res.status}`)
  }
  const data = (await res.json()) as {
    records: Array<{ uri: string; cid: string; value: unknown }>
  }
  const out: SharePostRecord[] = []
  for (const r of data.records) {
    if (isSharePost(r.value)) {
      out.push({ uri: r.uri, cid: r.cid, value: r.value })
    }
  }
  return out
}
