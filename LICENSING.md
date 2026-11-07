# Ultra Tasks licensing and provenance

Ultra Tasks is an open-source fork of [Super Productivity](https://github.com/super-productivity/super-productivity). The **current Ultra Tasks combined distribution uses GNU AGPL-3.0-only**, except where specific licenses and existing rights apply. This policy **does not revoke** MIT rights in inherited code or prior MIT-licensed releases of Ultra Tasks.

## License map

| Material                                                                      | Terms                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current combined Ultra Tasks client, server and project-owned packages        | [AGPL-3.0-only](LICENSE) to the extent Ultra Tasks has the necessary rights                                                                                            |
| Original Ultra Tasks code and improvements contributed after adoption         | AGPL-3.0-only by default unless an explicit exception applies                                                                                                          |
| Original Super Productivity code and older MIT-licensed contributions         | Original **MIT permissions remain valid**, including in files also carrying AGPL-covered modifications; [upstream MIT text](LICENSES/MIT-UPSTREAM.txt)                 |
| Independently deployed Ultra Tasks server                                     | Combined server distribution under [AGPL-3.0-only](apps/server/LICENSE); [original MIT notice](apps/server/LICENSE-MIT-UPSTREAM) remains |
| Third-party dependencies, independently licensed plugins, assets and material | Their separate notices and applicable licenses                                                                                                                         |

The AGPL declaration in a package manifest identifies the license for **that package as distributed here**, not an exclusive copyright claim over inherited material. An individual file can include separately MIT-licensed material and AGPL-covered improvements. Retain file-specific and third-party copyright notices.

## Original MIT rights remain

The original Super Productivity authors retain their copyrights. Their MIT code can still be used under the original MIT grant; the entire original [MIT license and copyright notice](LICENSES/MIT-UPSTREAM.txt) are preserved verbatim. The existing server also retains a standalone copy.

**Previously obtained MIT-licensed Ultra Tasks releases remain MIT-licensed under their existing grants.** Neither the new root license nor updated npm package metadata can retroactively revoke rights granted in those versions. Downstream users may independently use the original upstream code under MIT, but distribution of the _current Ultra Tasks combined application_ must also satisfy the AGPL terms for its AGPL-covered contributions.

## What AGPL means for a cloud business

AGPLv3 permits commercial operation, redistribution, self-hosting and forking, subject to its terms. It does not confer exclusive commercial hosting rights on Ultra Tasks. Section 13 can require an offer of Corresponding Source to users interacting remotely with a modified AGPL-covered network program.

Ultra Tasks Cloud subscriptions pay for a managed service (hosting, storage, availability, billing and support), **not** permission to use the open-source program. Self-hosted collaboration should not be disabled by hosted-plan entitlements.

## Contributions: outbound license and inbound grant

Accepted original contributions are normally distributed to the public as **AGPL-3.0-only**. Separately, the project requests an **explicit broad non-exclusive inbound license** from each contributor of original work, so the maintainer may use, modify, distribute, sublicense and **relicense** that contributor's own work under AGPL, other open-source licenses, or commercial licenses.

The separate inbound grant is described in [CONTRIBUTOR_LICENSE_AGREEMENT.md](CONTRIBUTOR_LICENSE_AGREEMENT.md) and is **not a copyright assignment**. Contributors retain ownership and may continue to use and license their work elsewhere.

The grant **requires affirmative assent** via the PR template's dedicated checkbox or an equivalent explicit acceptance statement in the PR. It is **not implied by merely submitting code**, and no prior contributor is retroactively bound. Maintainers should verify assent before merging new original contributions. Third-party or upstream MIT material may be included only on the terms of its own valid license; contributors cannot license rights they do not hold.

When offering an AGPL-only contribution back to the upstream MIT project, the relevant copyright holder must separately authorize distribution under MIT; the public AGPL license alone does not provide that permission.

## Review before merging this policy

1. Audit provenance and license compatibility of inherited and contributor-written source, generated files, vendored dependencies, bundled plugins and assets.
2. Check the plugin API and independently published libraries for compatibility; consider documented exceptions where beneficial.
3. Check Electron, mobile stores, Docker/binary release notices and hosted-service source-offer procedures.
4. Obtain qualified legal review of the CLA's recipient, grants, patent provisions and assent mechanism.
5. Keep an attribution inventory as new work is incorporated.

This explanatory policy does not supersede individual license texts or grant rights the project does not possess.
