# DiskLens

Local device storage explorer. The project is split into three independent parts so the web app can grow without turning `page.jsx` or `index.mjs` into one giant file.

## Project structure

```text
disklens-starter/
├─ frontend/
│  ├─ app/
│  │  ├─ page.jsx              # Next.js route entry only
│  │  ├─ layout.jsx            # Global app shell + global CSS
│  │  └─ globals.css
│  ├─ components/
│  │  ├─ DiskLensApp.jsx       # Main dashboard state + page UI
│  │  ├─ Sunburst.jsx           # Storage visualization
│  │  └─ Detail.jsx             # Reusable detail field
│  ├─ lib/
│  │  ├─ api.js                # Backend URL
│  │  ├─ formatters.js         # Bytes/date formatting
│  │  └─ sunburst.js            # Sunburst data helpers
│  ├─ .env.example
│  ├─ next.config.mjs
│  └─ package.json
│
├─ server/
│  ├─ src/
│  │  ├─ index.mjs              # Fastify bootstrap
│  │  ├─ db/
│  │  │  └─ database.mjs        # SQLite setup/schema
│  │  └─ routes/
│  │     ├─ health.mjs
│  │     ├─ scans.mjs
│  │     ├─ items.mjs
│  │     ├─ roots.mjs
│  │     ├─ storage.mjs
│  │     ├─ folders.mjs
│  │     └─ explorer.mjs
│  ├─ scripts/
│  │  └─ migrate.mjs
│  └─ package.json
│
├─ collector/
│  ├─ src/
│  │  ├─ index.mjs             # CLI/orchestrator
│  │  ├─ config.mjs            # Server URL + batch size
│  │  ├─ driveMetadata.mjs     # Windows drive metadata
│  │  ├─ scanner.mjs           # Filesystem scanning
│  │  └─ uploader.mjs          # Batch upload to server
│  └─ package.json
│
├─ .gitignore
└─ README.md
```

## What goes where

New frontend UI belongs in `frontend/components/`. Frontend-only helpers belong in `frontend/lib/`. API endpoints belong in `server/src/routes/`, while database/schema logic belongs in `server/src/db/`. Collector scanning logic stays in `collector/src/` and should remain small; new collector capabilities should normally become another focused module instead of expanding `index.mjs`.

## Run

### Server
```powershell
cd server
npm install
npm start
```

For development:
```powershell
npm run dev
```

### Collector
```powershell
cd collector
npm install
node src/index.mjs "A:\" "B:\" "C:\"
```

### Frontend
```powershell
cd frontend
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:8000`.

## Important

`server/disklens.db` is local runtime data and is intentionally ignored by Git. Keep the existing database when moving the project; do not replace it unless you intentionally want a fresh index.

The current uploaded collector reads drive capacity information for console output. The current uploaded server source does not yet expose a `/api/drives` endpoint, so that feature is separate from this structural reorganization.

The starter does not delete files or uninstall software.
