# Independent VNoctis development

## Baseline

The independently maintained fork is `seangoozey/VNoctis`. The VNoctis name and
upstream attribution are retained. Its `main` starts from the integrated
`server-combined` commit `6f02d0d`, including save sync/history/backups, browser
asset caching and offline preparation, legacy Ren'Py lookup compatibility,
background imports/builds and compression improvements.

The annotated tag `pre-independent-main-2026-10-18` preserves the previous fork
`main` at `bf7a871`. Promotion preserves the full commit/merge history; it does
not rewrite or squash it. Existing feature branches and upstream PRs are left
intact. Their review status does not gate work on this fork.

## Branch and remote workflow

The development checkout uses these remote names:

- `origin`: https://github.com/seangoozey/VNoctis.git
- `upstream`: https://github.com/starrlord/VNoctis.git

These are local Git settings, not repository-wide settings. An existing server
checkout may still call the fork `fork` and the original repository `origin`.
Check `git remote -v` before copying commands that name a remote.

New work starts from this fork's `main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/feature-name
# Make and validate the change, then commit it.
git push -u origin codex/feature-name
```

Merge reviewed/tested features into this fork's `main`. Deploy tested commits or
release tags from there. `server-combined` remains as a historical integration
branch; it does not need another parallel stream of new feature merges.
Old PR branches remain available for upstream review, but new work does not
have to be split across them. Fetch/cherry-pick upstream work selectively when
useful rather than automatically replacing this fork's baseline.

## Images and source builds

`compose.yml` defaults to this fork's image namespace:

- `ghcr.io/seangoozey/vnoctis-vnm-api:latest`
- `ghcr.io/seangoozey/vnoctis-vnm-builder:latest`
- `ghcr.io/seangoozey/vnoctis-vnm-ui:latest`

The existing Docker Images workflow uses the repository owner for publication
and runs on `main` pushes, version tags and manual dispatch when GitHub Actions
is enabled. Verify its first successful run and package visibility before using
anonymous image pulls. This change does not establish that those packages are
already published. Prefer immutable image tags/digests for a tested deployment.

Source builds need no published package. The thin build overlay keeps the same
bind mounts and environment as the base Compose file:

```bash
sudo docker compose -f compose.yml -f compose.build.yml config --quiet
sudo docker compose -f compose.yml -f compose.build.yml build vnm-api vnm-builder vnm-ui
sudo docker compose -f compose.yml -f compose.build.yml up -d --no-build --force-recreate vnm-api vnm-builder vnm-ui
```

The older standalone `compose_local_build.yml` uses named data volumes. Existing
installations using it must keep those volumes or migrate them explicitly; it
is not an interchangeable replacement for the bind-mount deployment above.

## Existing server transition

Promoting a development branch does not migrate or redeploy the TrueNAS server.
Before changing that checkout:

1. Record its current commit, Compose files, project name, `.env` settings and
   resolved mount locations. Preserve local Compose edits and permission/resource
   overrides before switching branches. Do not commit secrets, game files, data
   backups or server-only overrides to the public repository.
2. Export an all-user save backup, and take a consistent backup/snapshot of the
   deployment data. The save ZIP is not a complete application backup: it excludes
   account passwords/roles, settings, game files and web builds. Quiesce writers
   before copying SQLite data; include any WAL/sidecar state required by the
   backup method. Preserve `.env`, persisted signing/session keys and user IDs.
3. Keep the same data mounts, game directory names and browser origin where
   possible. The server root can change if the data is moved intentionally;
   directory-derived game identities and browser origin/account namespaces
   still determine automatic save/cache reuse. Renamed games need explicit
   mapping during save-backup restore. See [portable backups](save-sync.md#portable-save-backups).
4. Update to this fork's tested `main` commit. Keep the existing deployment
   invocation until its overrides have been compared. In the current server
   setup that means continuing to use **both** `-f compose.yml` and
   `-f compose.save-sync.yml`. Do not drop the latter just because its name is
   historical. The new source overlay can replace only its build/image entries;
   retain any other local settings separately.
5. Build/pull the chosen images, recreate the services and verify users, library,
   save ownership/history, imports, animations, Jobs and storage behavior before
   treating the transition as complete. Keep the pre-transition data backup for
   rollback; after schema migrations, an old application image alone may not be
   a sufficient rollback.

A fresh deployment can restore all-user saves before games are installed. Review
account mappings; newly created users are viewers and need passwords set by an
administrator. Missing games retain their saves until matching game identities
return. That remains separate from preserving an existing application's database.

## Overhaul roadmap

Keep changes small enough to test and roll back independently. This records the
next discussion and implementation order, not authorization for every item:

1. **Loading experience:** integrate save initialization into the game's progress
   display. After asset downloads finish, show “Preparing saves…” while the
   existing startup gate completes; do not make the toast control execution.
2. **Deployment and release foundation:** verify fork-owned image publication,
   add an automated regression gate, define release/version policy, reconcile
   the two older Compose layouts, and resolve the README's missing license-file
   link from verified upstream licensing before changing license text.
3. **Product/interface inventory:** agree the navigation, dashboard, library,
   launcher, Jobs and settings changes before redesigning them. Preserve
   admin/viewer boundaries, mobile layouts, accessibility and offline behavior.
4. **Implementation audit:** review startup/sync/storage boundaries and the
   background-job lifecycle, separate product decisions from refactoring, and
   keep migrations compatible with real existing libraries and save history.

The local ignored `test-data/feature-tracker` contains detailed investigation and
validation history; it is not part of a clone or a Git backup. This tracked guide
is the shared baseline for independent development. Detailed redesign scope and
priorities still need to be agreed.
