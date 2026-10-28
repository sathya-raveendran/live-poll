#!/usr/bin/env bash
# Publishes site/ to the gh-pages branch, which GitHub Pages serves.
# Uses the personal GitHub account's gh token so the global gh/git setup is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT="${GH_ACCOUNT:-sathya-raveendran}"
REPO="https://github.com/${ACCOUNT}/live-poll.git"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit your changes first; deploy publishes the committed site/ folder." >&2
  exit 1
fi

GH_TOKEN="$(gh auth token -u "$ACCOUNT")"
export GH_TOKEN
push() {
  git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' push "$@"
}

push "$REPO" main
SPLIT="$(git subtree split --prefix site HEAD)"
push --force "$REPO" "${SPLIT}:refs/heads/gh-pages"
echo "Deployed $(git rev-parse --short HEAD). GitHub Pages updates in about a minute: https://${ACCOUNT}.github.io/live-poll/"
