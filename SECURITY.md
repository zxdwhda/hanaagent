# Security Policy

This hanaagent repository is independently maintained by zxdwhda and derives from liliMozi/openhanako public 0.450.0 source.

## Reporting a Vulnerability

Use this repository’s private reporting form:
https://github.com/zxdwhda/hanaagent/security/advisories/new

Do not post credentials, personal conversations or exploit details in public issues. Include the affected version, environment, reproduction and impact. Private reporting is preferred; no guaranteed response time is promised during early maintenance.

## Scope

- Sandbox escape (PathGuard / Seatbelt bypass)
- Credential leakage
- Remote code execution
- Cross-site scripting in the Electron renderer

## Local credential storage

Provider keys, OAuth tokens, and device records live in the data directory
(`HANA_HOME`, by default `~/.hanaagent`). What the application guarantees:

- Files holding credentials are written readable and writable by their owner
  only, and the data directory itself is owner-only.
- Startup verifies this on every launch and restores it when it has drifted,
  which happens after restoring a backup or copying the directory between
  machines. Each correction is logged.
- Backups taken during data migrations hold copies of the same credentials.
  They are removed once they are older than 90 days, and only while the live
  catalog is readable and populated, since that is what a rollback would need.

Where that protection ends:

- Permissions decide which *accounts* may open the files. They do not restrict
  programs running as the same user, which can read anything that user can read.
  Narrowing that requires encryption keyed by the operating system's credential
  store, which this project does not do today.
- On Windows the guarantees above do not apply. NTFS does not implement POSIX
  permission bits, and the platform's file API cannot express them, so the
  application performs no permission work there at all. What protects the data
  is the access control list the data directory inherits from its parent. Under
  the default location inside the user profile that already excludes other
  standard accounts, but a data directory placed elsewhere through `HANA_HOME`
  inherits whatever that location grants, and the application neither adjusts
  nor reports it. On Windows, prefer leaving the data directory in its default
  location.
- Credentials are stored as plain text. Treat the data directory accordingly:
  keep it out of version control, shared drives, and archives you pass on.
