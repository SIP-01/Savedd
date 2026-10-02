# Heaven (Homegoing memorial videos, formerly "A Peaceful Goodbye")

A wizard that helps a user create a short, silent memorial video: a departed
loved one says goodbye to their family and walks hand-in-hand with Jesus
toward heaven. Built as a service to grieving Christian families and as a
shareable introduction to Savedd.com.

## Routes

| Route | Purpose |
|---|---|
| `/heaven` | The 5-step wizard (photos → family → their world → preview/consent → generating) |
| `/heaven/:id` | Public share page. The worker injects OG/Twitter video meta tags into the HTML so links unfurl on social platforms. |
| `/goodbye`, `/goodbye/:id` | Legacy paths from before the rename — redirect to `/heaven…`. |

## API (worker.ts, same origin)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/heaven/status` | GET | `{ configured: boolean }` |
| `/api/heaven/generate` | POST | multipart: `fields` (JSON) + `departedPhotos[]` + `familyPhotos[]` → `{ id, status, … }` (always 202; failure state is in the body) |
| `/api/heaven/status/:id` | GET | Lazily advances the xAI job; returns public meta + `videoUrl` when done |
| `/api/heaven/:id/meta` | GET | Public share-page metadata |
| `/api/heaven/:id/video` | GET | 302 → xAI CDN URL (or the R2-stored mp4 for legacy jobs) |
| `/api/heaven/:id/ref/:n` | GET | Stored reference photos (fetched by xAI during generation) |

`/api/goodbye/*` remains as a legacy alias for jobs/links created before the
rename.

## Operator setup

```bash
wrangler secret put XAI_API_KEY
wrangler kv namespace create HOMEGOING_JOBS
wrangler r2 bucket create savedd-homegoing
```

Then uncomment the `HOMEGOING_JOBS` / `HOMEGOING_BUCKET` bindings in
`wrangler.jsonc`. Without them the wizard still renders; generation returns
503 and forks stay fully functional.

## How generation works

1. Photos are stored in R2 under a random job id.
2. The fixed-story prompt is assembled in `src/lib/goodbye/homegoing.ts`
   (same validation client- and server-side). Reference images are passed to
   xAI as our own URLs (`/api/heaven/:id/ref/:n`).
3. `POST https://api.x.ai/v1/videos/generations` with
   `model: grok-imagine-video-1.5`, `reference_images` (as `{url}` structs),
   `duration`, `aspect_ratio`, `resolution: 720p`, and
   `storage_options: { filename, public_url: true }` → returns `request_id`.
4. The client polls `/api/heaven/status/:id` every 4 s; each poll performs
   one `GET /v1/videos/{request_id}` upstream. On `done` the permanent
   `video.file_output.public_url` (files-cdn.x.ai) is stored on the job —
   the video bytes stay on xAI's CDN and never transit Savedd's worker.
   (Fallback: if no public URL was produced, the ephemeral vidgen.x.ai URL
   is downloaded into R2 immediately before it expires.)
5. `/api/heaven/:id/video` 302-redirects to the xAI CDN URL (legacy jobs
   still serve the R2-stored copy). Job records expire after 30 days
   (KV TTL); the xAI public URL stays alive until revoked, and the stored
   `externalFileId` allows deleting the file via the xAI Files API.

## Guardrails

- Consent checkbox is required and enforced server-side.
- Adult subjects only; the prompt states it and the UI copy says it.
- The story is fixed — user text can only colour the setting, pets, and
  small details. All user text is length-capped and stripped of
  template-hostile characters.
- Every prompt instructs: no speaking, no graves/coffins/illness, modest
  clothing, faithful faces, and a small semi-transparent **Savedd.com**
  (two Ds) watermark bottom-center.
- Per-IP rate limiting reuses the worker's existing limiter.
- On upstream rejection, a redacted snippet (prompt and API key stripped)
  is stored in `job.debug` for operator diagnosis via KV. Clients only see
  the friendly message plus the upstream status code.

## Known limitations

- The watermark is requested in the Imagine prompt, not burned in
  server-side (no ffmpeg in a Worker). If cropping becomes a problem,
  re-encode with a burned watermark at storage time — that requires
  downloading the bytes once, which the R2 fallback path already shows.
- Reference-to-video caps at 720p and (currently) up to 15 s; the wizard
  offers 8/10/12/15 s.
- If identity drift on two reference photos is ever poor, the fallback is a
  two-step flow (grok-imagine-image-2.0 still → image-to-video). Not
  implemented in v1.
