#!/usr/bin/env bash
# Dispatch the two modes of the Swarmfile agent action.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${SWARMFILE_MODE:-agent}" in
  agent) exec bash "$here/agent.sh" ;;
  publish) exec bash "$here/publish.sh" ;;
  *) printf '::error::mode must be "agent" or "publish"\n' >&2; exit 1 ;;
esac
