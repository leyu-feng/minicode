#!/usr/bin/env bash

if [[ -z "${CONTAINER_ENGINE:-}" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    CONTAINER_ENGINE=docker
  else
    CONTAINER_ENGINE=podman
  fi
fi
case "$CONTAINER_ENGINE" in
  podman) CONTAINER_HOST_INTERNAL=host.containers.internal ;;
  docker) CONTAINER_HOST_INTERNAL=host.docker.internal ;;
  *) echo "CONTAINER_ENGINE must be podman or docker" >&2; return 1 ;;
esac
export CONTAINER_ENGINE CONTAINER_HOST_INTERNAL

require_container_engine() {
  command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
    echo "$CONTAINER_ENGINE is required; install it and add it to PATH" >&2
    return 1
  }
  "$CONTAINER_ENGINE" info >/dev/null 2>&1 || {
    echo "$CONTAINER_ENGINE is not reachable; start its Linux engine and retry" >&2
    return 1
  }
}

container_host_path() {
  if [[ "$CONTAINER_ENGINE" == "podman" && ( "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ) ]]; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

container() {
  if [[ "$CONTAINER_ENGINE" == "podman" && ( "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ) ]]; then
    local args=("$@") index source
    for ((index = 1; index < ${#args[@]}; index++)); do
      case "${args[index - 1]}" in
        -v|--volume)
          if [[ "${args[index]}" == /*:* ]]; then
            source="${args[index]%%:*}"
            args[index]="$(container_host_path "$source"):${args[index]#*:}"
          fi
          ;;
        -f|--file)
          if [[ "${args[0]}" == "build" || "${args[0]}" == "compose" ]]; then
            args[index]="$(container_host_path "${args[index]}")"
          fi
          ;;
      esac
      if [[ "${args[index]}" == /* && ( "${args[0]}" == "cp" || ( "${args[0]}" == "build" && index -eq $((${#args[@]} - 1)) ) ) ]]; then
        args[index]="$(container_host_path "${args[index]}")"
      fi
    done
    # Convert only host paths; MSYS would also rewrite container paths and volume separators.
    MSYS_NO_PATHCONV=1 "$CONTAINER_ENGINE" "${args[@]}"
  else
    "$CONTAINER_ENGINE" "$@"
  fi
}
