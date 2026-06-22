#!/bin/bash
# Usage: ./loop.sh [plan] [max_iterations] [--push]
# Examples:
#   ./loop.sh              # Build mode, unlimited iterations
#   ./loop.sh 20           # Build mode, max 20 iterations
#   ./loop.sh plan         # Plan mode, unlimited iterations
#   ./loop.sh plan 5       # Plan mode, max 5 iterations
#   ./loop.sh --push       # Build mode, push after each iteration
#   ./loop.sh plan --push  # Plan mode, push after each iteration

PUSH=false

# Parse arguments
ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--push" ]; then
        PUSH=true
    else
        ARGS+=("$arg")
    fi
done

if [ "${ARGS[0]}" = "plan" ]; then
    MODE="plan"
    PROMPT_FILE="PROMPT_plan.md"
    MAX_ITERATIONS=${ARGS[1]:-0}
elif [[ "${ARGS[0]}" =~ ^[0-9]+$ ]]; then
    MODE="build"
    PROMPT_FILE="PROMPT_build.md"
    MAX_ITERATIONS=${ARGS[0]}
else
    MODE="build"
    PROMPT_FILE="PROMPT_build.md"
    MAX_ITERATIONS=0
fi

ITERATION=0
CURRENT_BRANCH=$(git branch --show-current)
MARKER_FILE=".loop-complete"
CLAUDE_PID=""

# Clean up on script exit (Ctrl+C or otherwise)
cleanup() {
    echo ""
    if [ -n "$CLAUDE_PID" ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
        echo "Stopping Claude (PID $CLAUDE_PID)..."
        kill "$CLAUDE_PID" 2>/dev/null || true
        wait "$CLAUDE_PID" 2>/dev/null || true
    fi
    rm -f "$MARKER_FILE"
    echo "Loop stopped."
    exit 0
}
trap cleanup SIGINT SIGTERM

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Mode:   $MODE"
echo "Prompt: $PROMPT_FILE"
echo "Branch: $CURRENT_BRANCH"
echo "Push:   $PUSH"
[ $MAX_ITERATIONS -gt 0 ] && echo "Max:    $MAX_ITERATIONS iterations"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Verify prompt file exists
if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: $PROMPT_FILE not found"
    exit 1
fi

# Clean up any stale marker
rm -f "$MARKER_FILE"

while true; do
    if [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then
        echo "Reached max iterations: $MAX_ITERATIONS"
        break
    fi

    ITERATION=$((ITERATION + 1))
    echo -e "\n======================== LOOP $ITERATION ========================\n"

    # Run Claude in interactive mode (backgrounded so we can watch for the marker)
    # Pipe the prompt as initial input; Claude runs with full TUI visible
    {
        echo "# ITERATION $ITERATION — You are one step in a loop. Pick ONE task, implement it, commit, EXIT."
        echo ""
        cat "$PROMPT_FILE"
    } | claude --dangerously-skip-permissions &
    CLAUDE_PID=$!

    # Poll for the marker file — this is how Claude signals it's done
    while [ ! -f "$MARKER_FILE" ]; do
        if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
            # Claude exited on its own (e.g. error, user Ctrl+C'd it)
            break
        fi
        sleep 1
    done

    # Give Claude a moment to finish writing after creating the marker
    sleep 1

    # Terminate Claude if still running
    if kill -0 "$CLAUDE_PID" 2>/dev/null; then
        kill "$CLAUDE_PID" 2>/dev/null || true
        wait "$CLAUDE_PID" 2>/dev/null || true
    fi
    CLAUDE_PID=""

    # Check marker file to decide whether to continue or exit
    if [ -f "$MARKER_FILE" ]; then
        MARKER_CONTENT=$(cat "$MARKER_FILE")
        rm -f "$MARKER_FILE"

        if [ "$MARKER_CONTENT" = "exit" ]; then
            echo ""
            echo "All work complete."
            break
        fi
    fi

    if [ "$PUSH" = true ]; then
        git push origin "$CURRENT_BRANCH" || {
            echo "Failed to push. Creating remote branch..."
            git push -u origin "$CURRENT_BRANCH"
        }
    fi

    echo -e "\n"
    echo "─────────────────────────────────────────────────────────────"
    echo "Iteration $ITERATION complete. Starting next iteration..."
    echo "─────────────────────────────────────────────────────────────"
    sleep 2
done
