# SpatialPro architecture

SpatialPro uses a small layered architecture so UI, HTTP concerns, audio processing, and mutable files remain independent.

## Responsibility boundaries

### Frontend

- `frontend/index.html` contains semantic markup only.
- `frontend/assets/css/styles.css` owns design tokens, components, themes, and responsive rules.
- `frontend/assets/js/theme.js` applies the saved/system theme before first paint.
- `frontend/assets/js/audio-engine.js` owns decoded buffers, synchronized sources, Web Audio nodes, and spatial coordinates.
- `frontend/assets/js/app.js` owns DOM state, API calls, validation, rendering, and user interactions.

The frontend has no build tool or package-manager dependency. Flask serves `frontend/assets/` at `/assets/`.

### Backend

- `backend/__init__.py` creates Flask instances, registers routes, configures static assets, enforces upload limits, and attaches response security headers.
- `backend/config.py` is the single source of truth for project paths, supported models/extensions, limits, and stem metadata.
- `backend/routes.py` translates HTTP requests and service results without invoking subprocesses directly.
- `backend/services/separation.py` validates uploads, serializes Demucs access, manages job directories, executes the processor, sorts outputs, and guarantees temporary-upload cleanup.
- `run.py` exposes `app` for WSGI tools and starts the local development server when executed directly.

### Data

- `storage/demo/` is read-only bundled media used by demo mode.
- `storage/uploads/` is temporary request storage. Job subdirectories are always removed by the separation service.
- `storage/jobs/` contains successful generated stems and is the only generated media tree served to clients.
- `samples/audio/` contains tracked source examples and is never exposed by a catch-all static route.

## Request flows

### Page load

1. `GET /` returns `frontend/index.html`.
2. Flask's scoped static route serves `/assets/css/*` and `/assets/js/*`.
3. The browser calls `GET /health` and displays full-engine or demo-only capability.

### Saved demo

1. `GET /api/demo` validates all expected files in `storage/demo/`.
2. The API returns named, same-origin `/media/demo/*` URLs.
3. The Web Audio engine fetches and decodes all stems before enabling synchronized transport.

### Separation

1. `POST /process-audio` receives an `audio` multipart field and selected model.
2. The service validates model, extension, and size before acquiring the single processor slot.
3. The upload is saved as `storage/uploads/<job-id>/source.<ext>`; no client filename is used as a storage path.
4. Demucs writes beneath `storage/jobs/<job-id>/`.
5. WAV outputs are sorted by semantic stem identity and returned as `/media/jobs/<job-id>/*` URLs.
6. Temporary upload data is deleted in a `finally` block on success, failure, or timeout.

## Security boundary

The server exposes only the frontend shell, frontend assets, bundled demo WAVs, generated job WAVs, health, and processing endpoints. It does not provide a repository-wide catch-all route, so backend source, samples, Git metadata, and temporary uploads are not web-accessible.

SpatialPro is still a local single-user application. Public deployment would additionally require authentication, a durable job queue, per-user authorization, quotas, retention policies, and a production WSGI server.
