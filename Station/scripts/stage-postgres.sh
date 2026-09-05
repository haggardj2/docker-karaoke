#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/.build/postgres"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/bin" "${OUT_DIR}/lib" "${OUT_DIR}/lib64" "${OUT_DIR}/share/pgsql"

copy_from_installation() {
  local bindir="$1"
  local sharedir="$2"
  local pkglibdir="${3:-}"

  for binary in postgres initdb pg_ctl createdb psql pg_isready; do
    if [[ ! -x "${bindir}/${binary}" ]]; then
      echo "Missing PostgreSQL binary: ${bindir}/${binary}" >&2
      return 1
    fi
    cp -L "${bindir}/${binary}" "${OUT_DIR}/bin/"
  done

  cp -aL "${sharedir}/." "${OUT_DIR}/share/pgsql/"

  if [[ -n "${pkglibdir}" && -d "${pkglibdir}" ]]; then
    mkdir -p "${OUT_DIR}/lib/pgsql" "${OUT_DIR}/lib64/pgsql"
    cp -aL "${pkglibdir}/." "${OUT_DIR}/lib/pgsql/"
    cp -aL "${pkglibdir}/." "${OUT_DIR}/lib64/pgsql/"
  fi

  for binary in "${OUT_DIR}"/bin/*; do
    (ldd "${binary}" 2>/dev/null \
      | awk '/=> \// { print $3 } /^\// { print $1 }' \
      | grep -Ev '/(ld-linux|libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so)' \
      | while read -r lib; do
          if [[ -f "${lib}" ]]; then
            cp -nL "${lib}" "${OUT_DIR}/lib/" || true
            cp -nL "${lib}" "${OUT_DIR}/lib64/" || true
          fi
        done) || true
  done
}

stage_from_pg_config() {
  if ! command -v pg_config >/dev/null 2>&1; then
    return 1
  fi

  local bindir sharedir pkglibdir
  bindir="$(pg_config --bindir)"
  sharedir="$(pg_config --sharedir)"
  pkglibdir="$(pg_config --pkglibdir)"

  [[ -x "${bindir}/postgres" && -x "${bindir}/initdb" && -d "${sharedir}" ]] || return 1
  copy_from_installation "${bindir}" "${sharedir}" "${pkglibdir}"
}

stage_from_fedora_rpms() {
  command -v rpm2cpio >/dev/null 2>&1 || return 1
  command -v cpio >/dev/null 2>&1 || return 1

  local dnf_cmd=""
  if command -v dnf5 >/dev/null 2>&1; then
    dnf_cmd="dnf5"
  elif command -v dnf >/dev/null 2>&1; then
    dnf_cmd="dnf"
  else
    return 1
  fi

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  mkdir -p "${tmp}/rpms" "${tmp}/root"
  "${dnf_cmd}" download --destdir "${tmp}/rpms" --arch="$(uname -m)" \
    postgresql-server postgresql postgresql-private-libs postgresql-contrib

  for rpm in "${tmp}"/rpms/*.rpm; do
    (cd "${tmp}/root" && rpm2cpio "${rpm}" | cpio -idm --quiet)
  done

  copy_from_installation "${tmp}/root/usr/bin" "${tmp}/root/usr/share/pgsql" "${tmp}/root/usr/lib64/pgsql"

  if compgen -G "${tmp}/root/usr/lib64/libpq*.so*" >/dev/null; then
    cp -aL "${tmp}"/root/usr/lib64/libpq*.so* "${OUT_DIR}/lib/"
    cp -aL "${tmp}"/root/usr/lib64/libpq*.so* "${OUT_DIR}/lib64/"
  fi
}

if [[ -n "${PG_BINDIR:-}" && -n "${PG_SHAREDIR:-}" ]]; then
  copy_from_installation "${PG_BINDIR}" "${PG_SHAREDIR}" "${PG_PKGLIBDIR:-}"
elif ! stage_from_pg_config; then
  stage_from_fedora_rpms
fi

for binary in postgres initdb pg_ctl createdb psql pg_isready; do
  test -x "${OUT_DIR}/bin/${binary}"
done
test -f "${OUT_DIR}/share/pgsql/postgres.bki"

echo "Staged PostgreSQL runtime in ${OUT_DIR}"
