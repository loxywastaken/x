# Xine

An original, responsive X-inspired social interface connected to the real [Xitter](https://github.com/Xittered/xitter) backend. Accounts, password hashes, sessions, posts, replies, likes, reposts, bookmarks, follows, profiles, search, and notifications live in PostgreSQL. There are no shared demo identities in the default app.

## Open on GitHub and create your account

[Open Xine in GitHub Codespaces](https://codespaces.new/loxywastaken/x?ref=main), then create a Codespace. GitHub may require available Codespaces quota or billing; creating the Codespace is your choice. The included development container starts the app and a private PostgreSQL service automatically.

When setup finishes, open **Ports → 3000 → Open in Browser**. On the Xine page, select **Create an account**. Your app password is separate from your GitHub password. You do not need to send either password to anyone. The forwarded port is private by default. Stopping or deleting a Codespace affects availability; retain the database volume or back it up if you need to keep the accounts.

GitHub repository pages and GitHub Pages do not run this backend. The downloadable `xine.html` is only an offline demo; accounts require the running server. The Codespaces configuration has been structurally checked, but a real GitHub Codespace has not been launched from this environment.

## Start in this workspace

Requires Node.js 20+, Docker, and network access to npm and Docker Hub for first-time setup. Setup installs pinned Bun 1.4.3 alongside the checkout and creates a local PostgreSQL 18 container.

```sh
npm run setup
npm start
```

The app listens on port **3000**. Open it and choose **Create an account**. New instances use open sign-up. No default account, password, or administrator is created. Existing instance settings are preserved by subsequent setup runs.

- `npm run dev`: restart the backend when source files change.
- `PORT=3100 npm start`: use another app port.
- `PUBLIC_ORIGIN=https://your-domain.example`: set the browser-facing origin behind an HTTPS reverse proxy.
- `DATABASE_URL=postgres://… npm start`: use your own PostgreSQL database instead of local development PostgreSQL.
- `BUN_BIN=/path/to/bun`: override the Bun executable.

`npm run setup` provisions **development PostgreSQL** on loopback port **54329**, with a dedicated `xine-db` container and the `xine-postgres` Docker volume. Local development connections use trust authentication. Do not expose that database port publicly. For public deployment, use an authenticated database connection and HTTPS. Running setup does not deploy or publish anything.

## Accounts and administration

Sign-up, login, authenticator/backup-code challenges, session cookies, logout revocation, profile validation, moderation, and post visibility use Xitter's existing implementations. The Xine adapter checks same-origin requests, CSRF tokens, request sizes, standing, and rate limits. Likes and bookmarks are scoped to the authenticated viewer.

New members are regular accounts. To appoint an administrator after registering, run:

```sh
DATABASE_URL=postgres://xine@127.0.0.1:54329/xine \
  /workspace/.tools/xine/node_modules/.bin/bun scripts/make-admin.ts YOUR_USERNAME
```

Sign out and back in. The profile then offers **Administration**. Staff can change sign-up to invite-only or closed. The form respects those policies and single-use invites. Profiles also link to the existing two-factor and email settings pages.

No mail credentials are configured by setup. Without mail, account email addresses remain unverified. If SMTP or Resend is configured as described in [UPSTREAM.md](UPSTREAM.md), the Xine sign-up flow requires an emailed verification code before creating the account. Email delivery and public federation have not been tested against an external provider/instance.

The original `/admin`, `/account/*`, `/api/v1`, moderation, scheduling, and federation routes remain available. The Xine interface does not yet expose every upstream feature, including uploads, messaging, poll creation, and account migration. A new instance starts with an empty feed: create another account to start a conversation. The feed loads up to 100 recent entries per request; infinite scrolling is not implemented.

## Persistence and backups

The database persists in the Docker volume when the app restarts. Media, signing keys, and backend files are in ignored `media/` and `data/` directories. Keep these private and retain them with the database.

```sh
npm run db:backup
```

This writes a private dump of the local development database to ignored `.runtime/xine.dump`. Run it before snapshotting or moving this environment. Setup restores that dump only if the destination database has no `users` table; it never overwrites an existing database. Docker volume restoration in a fresh cloud task has not been independently verified. The dump and the media/key directories are the portable retained state.

## Validation

```sh
npm run test:backend
```

Uses a disposable database in the local `xine-db` container, deletes it afterward, and tests real account creation/login, per-user interactions, replies, search, notifications, profile isolation, CSRF and request-size rejection, logout revocation, restart persistence, protected accounts, restricted writes, two-factor challenges, and open/invite-only/closed sign-up policies. It does not use or reset member data.

The UI was also checked in Chromium with two independent desktop/mobile browser sessions: sign-up, posting, liking, saving, replying, searching, profile editing, logout, login, reload persistence, notifications, and mobile overflow.

`npm run test:unit` runs the upstream Bun suite. A separate ad-hoc TypeScript check finds existing errors across upstream modules; the repository does not define a typecheck script. Runtime/API and browser checks above are the readiness checks for this integration.

## Source and licensing

Based on Xitter commit `dfac9d7397f92b7bae175b5f64d8a45c3d695ef7`; upstream documentation is retained in [UPSTREAM.md](UPSTREAM.md). The Xine frontend is in `web/`, its adapter is `src/xine.ts`, and the main server registers it in `src/server.ts`. Xine ships its own interface and does not need to download X's proprietary client. The Docker entrypoint now configures Xine instead of fetching that client.

The earlier single-user prototype remains under `local/` for reference and is not the default runtime. AGPL-3.0-only licensing is retained in [LICENSE](LICENSE). Bundled fonts use the SIL Open Font License in `web/assets/`.
