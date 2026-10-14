# Cloud infrastructure acceptance — 2026-10-14

Acceptance is PARTIAL. Fixture transfer, isolated CPU execution, and editor HTTP save/reload work without the Mac. Sandboxed browser rendering fails, and the requested published configuration version cannot be verified here.

## Evidence

All times below are UTC on 2026-10-14. These are observations from this run, not guarantees about a later container.

| Step | Status | Observed | Evidence |
| --- | --- | --- | --- |
| Actual executor startup | PASS | 19:27:50–19:28:00 | Registration/handshake succeeded; Linux x86_64, Debian 13.6, agent UID 1000. Runtime ID `ccarenv_b64_Y2NhcmVudl81MTdlMDJhZGJkZDA4MTkxYTA2MDEyOGIzNGVlM2Y0Yw`; image `20261010195509-3f260dca55b9`, runtime bundle `26.1007.11041`. |
| Expected config version and startup policy | UNKNOWN | 19:28:48 | No authoritative runtime mapping to `2ce0a78b-62f3-4978-acc8-a4db55ba7297~cecfgver_6acfd20289cc8191baa44aa19d8c41ec`. No authenticated environment config reader/editor exposed. |
| Nonlogin Node/pnpm | PASS | 19:28:00 | Node v24.19.0; pnpm 10.32.1; no login-shell activation needed. |
| Initial dependency readiness | FAIL | 19:28:48 | First `pnpm check` failed: missing @anthropic-ai/sdk, openai, undici and @types/three. Startup did not leave this checkout ready. |
| Dependency recovery and CPU suite | PASS | 19:31:31; recipe rechecked 19:33:27 | `pnpm install --frozen-lockfile --ignore-scripts` repaired both primary and isolated checkouts. `pnpm check` passed lint, both typechecks and 89 tests in each; baseline main has 0 tasks. Tested nonlogin `setup.sh` saves the recovery recipe. |
| Exact Git source and isolation | PASS | 19:28:35; 19:33:27 | GitHub main and local HEAD: `2f82913156502dcc42c08a5067260ba6dde86015`; tree `0fb04688df550d9918959afe079aa6227d36d6ab`. Exported all 40 original tracked files and verified Git blob identities. Primary checkout remains clean. No native Git network fetch/clone tested. |
| Authorized package transfer | PASS | 19:29:16 | Supported Library materialization from `sdmntprsouthcentralus.oaiusercontent.com` succeeded: 122,389 bytes, 80 files; Library identity xattr retained. Effective access is proven; the policy allowlist itself is UNKNOWN. |
| Package integrity and fixture import | PASS | 19:31:30 | 79 SHA256SUMS entries, all 23 generated hashes, ZIP CRC, safe paths and 45 snapshot Git blob identities verified. Imported only 14 existing diagnostic JSON fixtures and 8 images into isolated directories. |
| Fixture compatibility and request construction | PASS | 19:32:55 | Current-main schema/reference checks: 14 checked, 0 problems; 14 local requests and 8 image parts built. Structural answer/group exclusion verified. No model calls. This does not certify semantic correctness or image-answer leakage. |
| Creator HTTP preview and save/reload | PASS | 19:32:55 | Six native routes return 200; all fixture images accessible. An unchanged existing fixture saves/reloads in a separate directory; create collision returns 409. All 22 input files remain byte-identical. |
| Sandboxed cloud browser rendering/save | FAIL | 19:32:55 | Chromium aborts: `/usr/lib/chromium/chrome-sandbox` must be owned by root. Observed mode 4755, owner nobody:nogroup. Writable XDG cache/config fixed the preceding crashpad error. No security relaxation attempted; visual rendering remains unverified. |
| Executor availability after disconnect callback | PASS | 19:34:40 | Bounded local command exited 0; Node/pnpm responded, result exists, original checkout clean at expected SHA. This proves executor access at that time, not an unseen control-plane recovery action. |
| Durable checkpoint and small-result retrieval | PASS | 19:35:12 | Remote branch readback equals `dbefca328bfb679d101650927188296b500a59e7`. Exact result text retrieved through GitHub: 4,865 bytes; Git blob `dd733f71779498fdff1f5aa85f4bd3d3c85f46a2`; SHA256 `f1b1d118c5978818de3115c982a3d668039a2cb7bc0098131b7bddeb2b7a3916`. Comparison changes only 8 new files under infra/cloud-acceptance/. |

The archive SHA256 recorded from the authorized download is `280c6b0eec0d77aca8a122d46731663cbe63f51c7d4db8221daf8b94ee396a99`. No independent outer checksum was supplied before that transfer. Its manifest identifies baseline `ea97a9b600676804c55addd20155d9ad8cf721a3` and runner snapshot `4d449e2a71ee93309954888b951327cdb2dbdb3c`; neither replaced current main. Archived generator, validator and package scripts were not executed. Fixture checksum verification precedes data import.

## Exact resume instructions

Pinned harness/receipt commit: `dbefca328bfb679d101650927188296b500a59e7` on `verify/cloud-acceptance-20261014`. This report is added afterward to that isolated branch. Do not merge it.

1. Reuse only a cloud executor. Discover currently available tools; do not infer a control-plane or browser capability from this report. Read workspace/repository instructions. Verify nonlogin Node/pnpm and actual runtime identity again.
2. Through the supported GitHub connector, retrieve these exact paths with `ref=dbefca328bfb679d101650927188296b500a59e7`: `infra/cloud-acceptance/{setup.sh,verify-fixtures.py,acceptance.mjs,result.json}` and the four files in `infra/cloud-acceptance/evidence/`. Use returned content and blob identities. The result can be read directly without a local runtime.
3. In the current executor, work already exists at `/workspace/cloud-acceptance-20261014`. For a new acceptance run, choose a new output directory. For a fresh executor with the pinned baseline commit already present locally, export source without modifying the checkout:

```sh
acceptance_root=/workspace/cloud-acceptance-resume-20261014
mkdir -p "$acceptance_root"
git -C /workspace/project-01-spatial-reasoning archive --format=tar \
  --output="$acceptance_root/source.tar" 2f82913156502dcc42c08a5067260ba6dde86015
python3 - "$acceptance_root" <<'PY'
import sys, tarfile
from pathlib import Path
root = Path(sys.argv[1])
with tarfile.open(root / "source.tar") as archive:
    archive.extractall(root / "source", filter="data")
PY
```

If that local commit is absent, retrieve the pinned source through a supported GitHub capability and verify all 40 blobs against `evidence/source-identity.json`; do not substitute an unverified latest branch. Place the three retrieved harness scripts in `$acceptance_root/tools/`.

4. Materialize fixture Library ID `libfile_ea3add3a38b08191bafea7121830a188`, pinned file ID `file_00000000ff5081f7bce98e81099c4ff3`, name `project-01-spatial-exploration-2026-10-12.zip`, through the supported Library flow and current official transfer helper. Check the returned download host against the approved host; preserve metadata. No raw URL fallback. If the helper/capability is unavailable, report that blocker.
5. With that ZIP at `$acceptance_root/incoming.zip`, run:

```sh
bash "$acceptance_root/tools/setup.sh" "$acceptance_root/source"
cd "$acceptance_root/source"
pnpm check
python3 "$acceptance_root/tools/verify-fixtures.py" \
  "$acceptance_root/incoming.zip" "$acceptance_root/fixtures"
node "$acceptance_root/tools/acceptance.mjs" \
  --source "$acceptance_root/source" --fixtures "$acceptance_root/fixtures" \
  --output "$acceptance_root/run" \
  --playwright /opt/codex/cua_node/lib/node_modules/playwright/index.mjs \
  --chromium /usr/bin/chromium
```

The browser arguments apply only when those cloud-local installed paths are present. Omitting `--playwright` records browser UNKNOWN. A browser failure yields exit 1 and still saves `run/result.json`. Input and output directories must be new. No research generator, benchmark model run, training job or controller should be started.

## Separate authenticated control-plane work

An environment owner/editor must inspect the exact expected config version above, its network allowlist, dependency startup hook and startup logs. This session cannot edit or prove those settings. Wire the reviewed pinned setup recipe only through that authorized editor, then create and test a fresh container. Publishing a changed config does not refresh an existing container.

Browser completion requires an authorized runtime-image/sandbox owner to resolve `/usr/lib/chromium/chrome-sandbox` ownership in the managed sandbox, or provide a supported sandboxed cloud browser API. The current observed owner is nobody:nogroup; Chromium requires root ownership and mode 4755. No chmod/chown, namespace, network or authentication changes were attempted. No additional security approval has been requested or granted in this task.

No Mac browser, filesystem, sockets or credentials were used. Existing training, fine-tunes, evaluations, resume chains and controllers received no actions; their health was not inspected. Sampled cloud credentials were reported only as presence/readiness. No new benchmark tasks or experiments were generated. Infinigen VM SKU/region was not retrieved in this task. Stop here and await parent follow-up.
