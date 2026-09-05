#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/.build/ffmpeg"
FFMPEG_IMAGE="${FFMPEG_IMAGE:-ghcr.io/haggardj2/ffmpeg-rubberband:latest}"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/bin" "${OUT_DIR}/lib"

copy_binary_deps() {
  local binary="$1"
  local copied=1

  while [[ "${copied}" -gt 0 ]]; do
    copied=0
    while read -r lib; do
      if [[ -f "${lib}" ]]; then
        local name
        name="$(basename "${lib}")"
        if [[ ! -e "${OUT_DIR}/lib/${name}" ]]; then
          cp -nL "${lib}" "${OUT_DIR}/lib/" || true
          copied=$((copied + 1))
        fi
      fi
    done < <(
      {
        ldd "${binary}" 2>/dev/null || true
        find "${OUT_DIR}/lib" -type f -name '*.so*' -exec ldd {} \; 2>/dev/null || true
      } | awk '/=> \// { print $3 } /^\// { print $1 }' \
        | grep -Ev '/(ld-linux|libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libresolv\.so|libnss_|libutil\.so)'
    )
  done
}

validate_staged_ffmpeg() {
  test -x "${OUT_DIR}/bin/ffmpeg"
  test -x "${OUT_DIR}/bin/ffprobe"

  export LD_LIBRARY_PATH="${OUT_DIR}/lib:${LD_LIBRARY_PATH:-}"

  local filters
  filters="$("${OUT_DIR}/bin/ffmpeg" -hide_banner -filters 2>/dev/null || true)"
  if ! grep -qE '(^|[[:space:]])rubberband([[:space:]]|$)' <<<"${filters}"; then
    echo "Staged FFmpeg does not include the rubberband filter required for pitch control." >&2
    exit 1
  fi

  "${OUT_DIR}/bin/ffprobe" -hide_banner -version >/dev/null
}

copy_from_source_dir() {
  local source_dir="$1"
  if [[ ! -x "${source_dir}/bin/ffmpeg" || ! -x "${source_dir}/bin/ffprobe" ]]; then
    echo "FFMPEG_SOURCE_DIR must contain bin/ffmpeg and bin/ffprobe" >&2
    return 1
  fi
  cp -aL "${source_dir}/." "${OUT_DIR}/"
}

stage_from_system() {
  command -v ffmpeg >/dev/null 2>&1 || return 1
  command -v ffprobe >/dev/null 2>&1 || return 1

  local ffmpeg_bin ffprobe_bin
  ffmpeg_bin="$(command -v ffmpeg)"
  ffprobe_bin="$(command -v ffprobe)"

  local filters
  filters="$("${ffmpeg_bin}" -hide_banner -filters 2>/dev/null || true)"
  if ! grep -qE '(^|[[:space:]])rubberband([[:space:]]|$)' <<<"${filters}"; then
    return 1
  fi

  cp -L "${ffmpeg_bin}" "${OUT_DIR}/bin/ffmpeg"
  cp -L "${ffprobe_bin}" "${OUT_DIR}/bin/ffprobe"
  copy_binary_deps "${ffmpeg_bin}"
  copy_binary_deps "${ffprobe_bin}"
}

stage_from_container_image() {
  local engine=""
  if command -v docker >/dev/null 2>&1; then
    engine="docker"
  elif command -v podman >/dev/null 2>&1; then
    engine="podman"
  else
    return 1
  fi

  "${engine}" pull "${FFMPEG_IMAGE}"

  local container_id
  container_id="$("${engine}" create "${FFMPEG_IMAGE}")"
  cleanup() {
    "${engine}" rm -f "${container_id}" >/dev/null 2>&1 || true
  }
  trap cleanup RETURN

  "${engine}" cp "${container_id}:/opt/ffmpeg/." "${OUT_DIR}/"
}

if [[ -n "${FFMPEG_SOURCE_DIR:-}" ]]; then
  copy_from_source_dir "${FFMPEG_SOURCE_DIR}"
elif stage_from_system; then
  :
else
  stage_from_container_image
fi

validate_staged_ffmpeg

echo "Staged FFmpeg runtime with rubberband support in ${OUT_DIR}"
