# Security policy

starcoach-trader trades real money through an exchange API key, so security is part of the design, not an add-on. The full description of the controls is in [docs/SECURITY.md](docs/SECURITY.md).

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub: **Security, then Report a vulnerability** on this repository. Do not open a public issue for a security problem. Include what you found, how to reproduce it and the commit (`git rev-parse --short HEAD`).

We aim to acknowledge a report within 2 working days and to ship a fix or a mitigation within 14 days for anything that affects funds, credentials or order placement.

## Scope

In scope: the trading daemon, the exchange and AI clients, the dashboard, the Docker image and the CI pipeline. Out of scope: vulnerabilities in the Wallex platform itself (report those to Wallex) and in third-party model providers.

## Supported versions

Only the latest commit on `main` and the tagged commit used for a trading run receive fixes.

## Handling secrets

- Use a **trade-only** Wallex API key. Withdrawal must stay disabled on the key.
- Secrets live only in environment variables (`.env`, which is git-ignored). The configuration loader refuses to read a secret from any `.toml` file.
- If a key is ever exposed, revoke it in the Wallex panel first, then rotate it here.
