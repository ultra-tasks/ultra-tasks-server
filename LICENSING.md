# Ultra Tasks licensing policy

Ultra Tasks is an open-source fork of [Super Productivity](https://github.com/super-productivity/super-productivity). It uses **scoped licenses**, rather than replacing the original MIT license with a repository-wide copyleft license.

## License map

| Scope                                                                                                                                                        | License for the Ultra Tasks distribution             | Where to read it                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Client application, Electron/mobile clients, shared packages and other files not covered by a more specific license                                          | MIT                                                  | [LICENSE](LICENSE)                                                                                   |
| `packages/super-sync-server/` — the Ultra Tasks distribution of the hosted synchronization server and future collaboration functionality within that package | GNU AGPL-3.0-only                                    | [packages/super-sync-server/LICENSE](packages/super-sync-server/LICENSE)                             |
| Original Super Productivity code incorporated in either area                                                                                                 | Original MIT permissions and notices remain in force | [LICENSE](LICENSE) and [server upstream MIT notice](packages/super-sync-server/LICENSE-MIT-UPSTREAM) |
| Third-party dependencies, bundled assets, plugins and content with their own notices                                                                         | Their respective licenses                            | See each component's notices and licenses                                                            |

The root `package.json` remains `MIT`; the server's `package.json` declares `AGPL-3.0-only`. These markers describe the licensing of the respective distributed packages, not a retroactive withdrawal of rights to inherited code.

## Inherited code and prior grants

- The original Super Productivity authors and other contributors retain their copyrights. Their MIT-licensed code remains available under MIT, including from the upstream project.
- The server's AGPL-3.0-only terms apply to the combined server version distributed by Ultra Tasks to the extent licensing rights permit. MIT-licensed portions **do not cease to be MIT-licensed**; their existing grants cannot be revoked by this change.
- Preserve the complete upstream MIT text and notices when redistributing any substantial portions of inherited MIT code. The server retains a standalone copy because it can be built and deployed separately.
- Previously obtained MIT-licensed versions of Ultra Tasks remain available under their original grants.

## What AGPL does and does not do

AGPL-3.0-only is an OSI-approved open-source license. It allows using, modifying, redistributing, self-hosting, and **commercially hosting** AGPL-covered software. It does not give Ultra Tasks an exclusive right to operate a hosted service.

A party operating a **modified** AGPL-covered network service must comply with applicable section 13 obligations, including offering its Corresponding Source to remote users. Other AGPL obligations may apply to redistribution. See the actual [server license](packages/super-sync-server/LICENSE), not this summary, for controlling terms.

The official Ultra Tasks Cloud subscription, billing, quotas, branding, support, and uptime commitments are **service offerings**, not extra restrictions imposed on the AGPL-covered software. Self-hosted server deployments should not be artificially feature-gated to reproduce hosted subscription tiers.

## New development and contributions

- New changes **within** `packages/super-sync-server/` should be submitted for distribution under AGPL-3.0-only and include attribution for third-party contributions where required.
- Reusable client and shared-library code elsewhere remains MIT unless a separately reviewed, clearly scoped licensing decision changes it.
- New server packages must explicitly document their license; do not assume that all future services are automatically AGPL-covered by this file.
- For code copied or ported from upstream, verify licensing and preserve original notices. Do not claim exclusive ownership of upstream contributions.
- Contributors keep their copyright. Any future contributor agreement or dual-license proposal would require a separate, explicit review.

## Review before merge

This proposal affects the license of the **distributed existing SuperSync server**, even though the planned multi-user collaboration system has not been implemented. Before merging:

1. Review whether all incorporated server files, bundled dependencies, generated code, and distribution artifacts are compatible with AGPL-3.0-only and retain required notices.
2. Check binary packaging, Docker image source-availability and notice paths, and any marketplace/store obligations.
3. Verify the server-side network source-offer obligations for a future modified hosted deployment.
4. Obtain legal review if this project will offer a paid commercial hosting service or receive material third-party contributions.

This page is an explanatory repository policy; it is not a replacement for the license texts or legal advice.
