# Security Policy

> [!WARNING]
> Moth is an experimental, unaudited, and unsupported reference implementation.
> Shielded Technologies does not guarantee maintenance, security fixes, response
> to vulnerability reports, or continued availability. Do not use Moth with
> assets you are not prepared to lose. See the
> [README status notice](./README.md#status-experimental-and-unsupported).

## Reporting a vulnerability

Moth is not covered by a vulnerability-response SLA. Shielded Technologies
does not monitor, triage, or patch security issues for this repository and does
not guarantee a response to reports.

If a finding also affects a supported Shielded Technologies product or an
organization-wide system, do not open a public issue. Report it through one of
these private channels:

- **Preferred:** [GitHub private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on the affected repository.
- **Email fallback:** `security@shielded.io` for organization-wide concerns or
  when GitHub private reporting is unavailable.

You may use the same channels to notify Shielded Technologies about a
Moth-specific finding, but the unsupported status and lack of response or
remediation commitment still apply.

Please include:

- Repository name, URL, and observed commit.
- Issue type and affected paths.
- Configuration or environment needed to reproduce.
- Reproduction steps and minimal proof of concept.
- Potential impact and suggested mitigations.

## Scope

Moth is published for reference and evaluation only. It is not a supported
release and is outside Shielded Technologies' supported-product vulnerability
management process.

Report these issues to the relevant upstream project:

- Vulnerabilities in third-party dependencies, unless Moth's usage materially
  changes the impact.
- Issues in the Midnight Network protocol or another upstream network.
- Issues in third-party infrastructure or services.

## Safe harbor

Shielded Technologies will not pursue legal action against good-faith
researchers who:

- Report privately through the channels above.
- Avoid privacy violations, data destruction, and service interruption.
- Do not access or retain data beyond what is necessary to demonstrate the
  issue.
- Allow reasonable time before publicly disclosing a finding.

Safe harbor does not create a support, response, remediation, or disclosure
commitment for this repository.

## Suggesting policy changes

Open an issue or pull request for non-sensitive policy improvements. Send
sensitive policy concerns to `security@shielded.io`.
