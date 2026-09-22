# Move the current DiskLens into the arranged structure

1. Stop the frontend, server and collector.
2. Keep a backup of your current `server/disklens.db`.
3. Extract this arranged project as a new `disklens-starter` folder.
4. Copy your existing `server/disklens.db` into the new project's `server/` folder.
5. Install dependencies once in each package:

```powershell
cd frontend
npm install

cd ..\server
npm install

cd ..\collector
npm install
```

6. The old files are now obsolete and can be deleted from the old project/source copy:

```text
collector/index.mjs
server/index.mjs
server/migrate.mjs
```

They have moved to:

```text
collector/src/index.mjs
server/src/index.mjs
server/scripts/migrate.mjs
```

7. For the frontend API URL, copy:

```text
frontend/.env.example -> frontend/.env.local
```

8. Run normally:

```powershell
# server
cd server
npm run dev

# frontend, in another terminal
cd frontend
npm run dev

# collector, in another terminal
cd collector
node src/index.mjs "A:\" "B:\" "C:\"
```

The database location stays `server/disklens.db`, so the existing indexed data is preserved when you copy it over.
