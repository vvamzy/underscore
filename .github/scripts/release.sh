#!/usr/bin/env bash
set -euo pipefail

target=$(git rev-parse HEAD)
stable='v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})'
tags=$(git tag --sort=-version:refname)
existing_tags=$(git tag --points-at "$target" --sort=-version:refname)

if [[ ${GITHUB_EVENT_NAME:-} == 'workflow_dispatch' ]]; then
  tag="v${RELEASE_VERSION#v}"
  if [[ ! $tag =~ ^${stable}$ ]]; then
    echo 'Expected a stable release version such as 1.1.0.' >&2
    exit 1
  fi
else
  # Retries reuse a stable tag already on this merge commit.
  tag=$(grep -m1 -Ex "$stable" <<< "$existing_tags" || true)
  if [[ -z $tag ]]; then
    latest=$(grep -m1 -Ex "$stable" <<< "$tags" || true)
    [[ ${latest:-v0.0.0} =~ ^${stable}$ ]]
    tag="v${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
  fi
fi

args=(--target "$target" --title "Release $tag" --generate-notes)
if git show-ref --verify --quiet "refs/tags/$tag"; then
  if [[ $(git rev-parse "refs/tags/$tag^{commit}") != "$target" ]]; then
    echo "$tag already points to a different commit." >&2
    exit 1
  fi
  args+=(--verify-tag)
fi

if gh release view "$tag" >/dev/null 2>&1; then
  echo "Release $tag already exists."
  exit 0
fi

if [[ ${RELEASE_DRAFT:-false} == 'true' ]]; then
  args+=(--draft)
fi
gh release create "$tag" "${args[@]}"
