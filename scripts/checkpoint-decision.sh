#!/usr/bin/env bash
# Decide what the action should do with one `swarmfile checkpoint --json`
# response. The engine distinguishes a genuine no-change branch (`no_changes`)
# from a retryable/unconfirmed commit (`not_committed`); never infer "no
# changes" from a missing reason.
#
# Usage: checkpoint_decision <checkpointed> <reason> <changesetId>
# Prints: committed | no_changes | submit | retry | fail
checkpoint_decision() {
  local checkpointed="$1" reason="$2" changeset="$3"
  if [ "$checkpointed" = "true" ]; then
    printf 'committed\n'
    return 0
  fi
  case "$reason" in
    no_changes)
      if [ -z "$changeset" ]; then printf 'no_changes\n'; else printf 'fail\n'; fi
      ;;
    changelist_open)
      printf 'submit\n'
      ;;
    commit_in_progress|previous_commit_in_progress|not_committed)
      printf 'retry\n'
      ;;
    *)
      # A missing/empty reason is an error body, not a confirmation; session
      # minting being unavailable means the commit hash cannot be derived.
      printf 'fail\n'
      ;;
  esac
}
