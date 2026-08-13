# Security Policy

Shielded Technologies takes security seriously. This policy covers every repository under the [`shieldedtech` GitHub organization](https://github.com/shieldedtech).

## Reporting a vulnerability

**Do not open a public issue.** Report security vulnerabilities through one of the following private channels:

- **Preferred:** [GitHub private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on the affected repository.
- **Email fallback:** `security@shielded.io` — for cases where GitHub reporting is unavailable, or for org-wide concerns that don't map to a single repo.

Please include as much of the following as you can:

- Repository name / URL.
- Issue type (e.g. cryptographic flaw, privacy leak, RCE, supply-chain, dependency CVE).
- Affected file paths and the commit/tag/branch you observed it on.
- Configuration or environment needed to reproduce.
- Step-by-step reproduction.
- Proof-of-concept code, if you have one.
- Your assessment of impact and any suggested mitigations.

## What to expect

- **Acknowledgement** within 3 business days.
- **Triage response** within an additional 3 business days, including next steps.
- **Coordinated disclosure** — we will agree a public disclosure date with you before publishing an advisory.

If you don't hear back in the window above, escalate to `security@shielded.io` with the GitHub advisory link.

## Scope

In scope: any first-party code in `shieldedtech/*` repositories, including production services, libraries, smart contracts, and infrastructure-as-code.

Out of scope (report to the upstream vendor, not us):

- Vulnerabilities in third-party dependencies — unless our usage materially amplifies the impact.
- Issues in the Midnight Network protocol or other upstream networks — report those to the relevant project.
- Social-engineering, physical-access, or denial-of-service scenarios against unrelated infrastructure.

## Safe harbor

We will not pursue legal action against good-faith researchers who:

- Report vulnerabilities through the channels above.
- Avoid privacy violations, destruction of data, and interruption of service.
- Do not exfiltrate data beyond what is necessary to demonstrate the issue.
- Give us reasonable time to remediate before disclosure.

## Vulnerability management

After triage, the assigned maintainer will:

1. Confirm the issue and identify affected versions.
2. Audit adjacent code for similar problems.
3. Prepare fixes for all supported releases.
4. Coordinate the public advisory (CVE assignment where applicable).

## Preferred language

English.

## Suggesting policy changes

If you'd like to improve this document, open an issue or PR. For sensitive policy concerns, email `security@shielded.io`.
