# SOOP rules — List-KR attribution

The nine network filters and one scriptlet rule preserved in `soop.source.txt`
are a small subset of [List-KR](https://github.com/List-KR/List-KR), copyright
List-KR contributors. List-KR declares GNU GPLv3; its pinned
[LICENSE](https://github.com/List-KR/List-KR/blob/9c2eab0a382be0d9c8716fcc363ba32b3ff36e62/LICENSE)
and [README](https://github.com/List-KR/List-KR/blob/9c2eab0a382be0d9c8716fcc363ba32b3ff36e62/README.md)
are the licensing references. The GPLv3 text is also included at `../LICENSE.txt`.
No warranty is provided. Retain these notices and corresponding source when
redistributing the derived rules under GNU GPLv3.

Snapshot: `9c2eab0a382be0d9c8716fcc363ba32b3ff36e62`, committed
2026-09-30 22:18:35 UTC, checked 2026-10-03. Upstream file hashes, byte sizes,
selected line numbers, and the generated rules hash are in `soop.metadata.json`.

## Sources

- [Domain filters](https://github.com/List-KR/List-KR/blob/9c2eab0a382be0d9c8716fcc363ba32b3ff36e62/filterslists/adblocking/filters-share/3rd_domains.txt)
- [URL filters](https://github.com/List-KR/List-KR/blob/9c2eab0a382be0d9c8716fcc363ba32b3ff36e62/filterslists/adblocking/filters-share/specific_URL.txt)
- [VOD adballoon scriptlet rule](https://github.com/List-KR/List-KR/blob/9c2eab0a382be0d9c8716fcc363ba32b3ff36e62/filterslists/adblocking/filters-uBO/scriptlets.txt#L28)

## Local changes

On 2026-10-03 the nine network filters were converted to Chrome MV3 DNR
`block` rules at priority 1000 with IDs 1–9, in original selection order.
Each filter string is unchanged, but the rules are deliberately narrower:
`initiatorDomains: ["sooplive.com"]` and `excludedResourceTypes: ["main_frame"]`.
This limits the supplemental rules to requests initiated by SOOP documents
and does not block direct top-level navigation to the listed domains.
The existing user allowlist at priority 10000 overrides these rules.
SOOP rules remain enabled when the smaller `ads` fallback replaces EasyList.

`../sites/soop.js` is an independent implementation of the intent of the
adballoon rule, not a copied uBO or AdGuard engine. It removes only the own
`data.adballoon` field from successful JSON responses at the exact HTTPS
`api.m.sooplive.com/station/video/a/view` endpoint, on `vod.sooplive.com`.
It handles both XHR text/JSON and fetch; the source filter only specifies XHR.
Unlike the source's substring match, other hosts and paths are untouched.
Video files, subscription/access flags, preroll/midroll flags and schedules
are not modified. This field controls an adballoon promotion, not the video
ad stream itself.

No filter updates or executable code are fetched at extension runtime.
To update, review a new upstream commit, update the selected source strings,
DNR conversion and metadata together, then run the static, unit, and Chromium
tests documented in `../README.md`. This subset is not full List-KR support.
