# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use **GitHub's private vulnerability reporting** (the repository's
**Security** tab, then **Report a vulnerability**) and include what you found, the steps to reproduce it, and the version of Alcove.
You can expect a first answer within a few days.

## What is supported

Only the latest release. Alcove does not update itself, so after a security fix is released, use **Settings › About › Check for updates** and install the new version.

## What counts

Alcove is a browser, so these matter most: a website reaching Alcove's own pages or commands, a file or page escaping the sandbox,
the Markdown editor reading or writing files it should not, an extension doing more than it was shown to do, and anything that
sends data off the device without saying so (see the privacy section of the README).

How the app is put together, and what each part is allowed to do, is described in [docs/DEVELOPER.md](docs/DEVELOPER.md)
(sections 3, 4 and 7).
