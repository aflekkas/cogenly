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
      Allow only workflows dispatched from `main`.
- [ ] Create environment **production**, with a required maintainer reviewer
      (manual approval). Allow only workflows dispatched from `main`.
- [ ] Configure production self-review rules to fit the maintainer team: a solo
      maintainer needs to be able to approve their own dispatch. Restrict bypass
      if another reviewer is available. Without environment protection, the
      workflow cannot itself enforce approval.
- [ ] Allow the workflow's `contents: write` permission for its publish job and
      `actions: read` for its resolve job, which checks the commit's CI run.
      No PAT or npm token is required; `GITHUB_TOKEN` is automatically supplied.
      Keep the default token permission read-only for other jobs.
- [ ] When Apple enrollment is complete, add **repository Actions secrets**:
      `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
      `APPLE_API_ISSUER`. All five are optional until signing is ready; none is
      required for an unsigned staging/prod release. See [signing setup](./release.md#signing-and-notarization).
- [ ] No relay, Discord, AUR, npm, mobile, or hosted-web credentials are needed.
- [ ] Push a small change to `main`; verify all three CI checks run and no
      Release run starts. Promote it with
      `gh workflow run release.yml --ref main -f ref=<sha>`; verify it pauses at
      production approval, then publishes arm64 DMG + zip + `latest-mac.yml` +
      blockmaps + `SHA256SUMS` and the unsigned/signed label on the resulting
      latest prod release. A `-f channel=staging` dispatch publishes a
      prerelease with `staging-mac.yml` instead.

The workflow uses GitHub's `concurrency.queue: max` to retain pending releases
per channel.
Older actionlint versions (including 1.7.12) do not recognize that supported key;
validate with `actionlint -ignore 'unexpected key "queue" for "concurrency" section'`
until the validator supports it. Review any other errors normally.
