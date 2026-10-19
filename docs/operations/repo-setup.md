# GitHub repository setup

Apply these settings to `aflekkas/cogenly` after reviewing the workflow changes.
This checklist does not apply settings automatically.

- [ ] Default branch is `main`; Actions are enabled and may use checkout,
      setup-vp, rust-toolchain, github-script, and upload/download-artifact.
- [ ] Protect `main`: require pull requests, require branches to be up to date,
      block force pushes/deletion, and require these exact check names from CI:
      **Lint**, **Typecheck**, **Test**. Run CI once so GitHub can offer the names.
      Do not require a release job on PRs.
- [ ] Prefer squash merges and require linear history. Set the review count to
      the maintainer policy; do not require an unavailable second maintainer for
      a solo repository. Decide explicitly whether administrators may bypass.
- [ ] Create environment **staging**, with no manual approval requirement.
- [ ] Create environment **production**, with a required maintainer reviewer
      (manual approval). Allow only workflows dispatched from `main`. For staging,
      allow main-branch runs. Check that the actual `workflow_run` deployment is
      allowed by the environment's branch rule after the first run.
- [ ] Configure production self-review rules to fit the maintainer team: a solo
      maintainer needs to be able to approve their own dispatch. Restrict bypass
      if another reviewer is available. Without environment protection, the
      workflow cannot itself enforce approval.
- [ ] Allow the workflow's `contents: write` permission for its publish job.
      No PAT or npm token is required; `GITHUB_TOKEN` is automatically supplied.
      Keep the default token permission read-only for other jobs.
- [ ] When Apple enrollment is complete, add **repository Actions secrets**:
      `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
      `APPLE_API_ISSUER`. All five are optional until signing is ready; none is
      required for an unsigned staging/prod release. See [signing setup](./release.md#signing-and-notarization).
- [ ] No relay, Discord, AUR, npm, mobile, or hosted-web credentials are needed.
- [ ] Merge a small PR; verify all three CI checks, a staging prerelease with
      arm64 DMG + zip + `staging-mac.yml` + blockmaps + `SHA256SUMS`, and the
      unsigned/signed label. Verify a promotion pauses at production approval
      and publishes `latest-mac.yml` only on the resulting latest prod release.

The workflow uses GitHub's `concurrency.queue: max` to retain pending releases.
Older actionlint versions (including 1.7.12) do not recognize that supported key;
validate with `actionlint -ignore 'unexpected key "queue" for "concurrency" section'`
until the validator supports it. Review any other errors normally.
