# The Software Factory's GitHub identity, for one shell.
#
# Source it, never execute it, at the start of every shell that runs gh or git:
#   . /workspace/.kortix/software-factory/scripts/github-identity.sh
#
# It pins gh and git to FACTORY_GITHUB_TOKEN, checks that the token's login is
# identity.github_login in factory.json, and sets the commit author to the
# factory's identity. It is idempotent: source it again in every new shell.
# On any failure it unsets GH_TOKEN and returns non-zero, so no later command
# runs as another account. It never prints the token.

factory_github_identity() {
  # No other GitHub credential or author override may leak into this shell.
  unset GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST
  unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

  for tool in gh git jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      unset GH_TOKEN
      printf 'factory-identity: errors=no-%s\n' "$tool" >&2
      return 127
    fi
  done
  unset tool

  if [ -z "${FACTORY_GITHUB_TOKEN:-}" ]; then
    unset GH_TOKEN
    printf '%s\n' 'factory-identity: errors=no-token (FACTORY_GITHUB_TOKEN is not set: kortix secrets request FACTORY_GITHUB_TOKEN --scope runtime)' >&2
    return 2
  fi

  export GH_TOKEN="$FACTORY_GITHUB_TOKEN"
  export GH_PROMPT_DISABLED=1
  export GIT_TERMINAL_PROMPT=0

  _fgi_user="$(gh api user --jq '[.login, (.id | tostring), (.name // "")] | @tsv' 2>/dev/null)" || {
    unset GH_TOKEN _fgi_user
    printf '%s\n' 'factory-identity: errors=token-rejected (GitHub refused FACTORY_GITHUB_TOKEN: expired, revoked or mistyped)' >&2
    return 1
  }
  _fgi_login="$(printf '%s' "$_fgi_user" | cut -f1)"
  _fgi_id="$(printf '%s' "$_fgi_user" | cut -f2)"
  _fgi_gh_name="$(printf '%s' "$_fgi_user" | cut -f3)"

  _fgi_config="${FACTORY_CONFIG:-/workspace/.kortix/software-factory/factory.json}"
  _fgi_want_login=''
  _fgi_want_name=''
  _fgi_want_email=''
  if [ -f "$_fgi_config" ]; then
    _fgi_want_login="$(jq -r '.identity.github_login // empty' "$_fgi_config" 2>/dev/null)"
    _fgi_want_name="$(jq -r '.identity.name // empty' "$_fgi_config" 2>/dev/null)"
    _fgi_want_email="$(jq -r '.identity.email // empty' "$_fgi_config" 2>/dev/null)"
  fi

  if [ -n "$_fgi_want_login" ] && [ "$_fgi_want_login" != "$_fgi_login" ]; then
    unset GH_TOKEN
    printf 'factory-identity: errors=wrong-identity (the token is %s, factory.json identity.github_login is %s)\n' "$_fgi_login" "$_fgi_want_login" >&2
    unset _fgi_user _fgi_login _fgi_id _fgi_gh_name _fgi_config _fgi_want_login _fgi_want_name _fgi_want_email
    return 1
  fi

  _fgi_name="${_fgi_want_name:-${_fgi_gh_name:-$_fgi_login}}"
  _fgi_email="${_fgi_want_email:-${_fgi_id}+${_fgi_login}@users.noreply.github.com}"

  # git asks gh for github.com credentials; gh answers with GH_TOKEN.
  gh auth setup-git --hostname github.com >/dev/null 2>&1 || {
    unset GH_TOKEN
    printf '%s\n' 'factory-identity: errors=setup-git' >&2
    return 1
  }

  git config --global user.name "$_fgi_name"
  git config --global user.email "$_fgi_email"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git config --local user.name "$_fgi_name"
    git config --local user.email "$_fgi_email"
  fi

  export FACTORY_GITHUB_LOGIN="$_fgi_login"
  export FACTORY_GIT_NAME="$_fgi_name"
  export FACTORY_GIT_EMAIL="$_fgi_email"
  printf 'factory-identity: login=%s author=%s <%s>\n' "$_fgi_login" "$_fgi_name" "$_fgi_email" >&2
  unset _fgi_user _fgi_login _fgi_id _fgi_gh_name _fgi_config _fgi_want_login _fgi_want_name _fgi_want_email _fgi_name _fgi_email
  return 0
}

factory_github_identity
