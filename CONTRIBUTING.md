# Contributing

Run `npm ci`, then `npm run format:check`, `npm run typecheck`, `npm run build` and `npm test`
before opening a pull request. Tests start real servers on `127.0.0.1` with port 0, so they need
no setup and never leave anything listening.
