# Project Plan: TUI UI Fixes

## Overview
Fix bugs in the TUI application regarding "Mine/All" data filtering and the detail screen loading mechanism. Additionally, simplify the UI by removing redundant, colored action buttons that are already covered by keybindings.

## Project Type
**WEB/CLI/TUI (Python)**

## Success Criteria
1. Switching to "Mine" correctly filters and displays resources created by the current user (using correct profile name instead of hardcoded username).
2. The Detail screen fetches fresh data from the database/API cache instead of relying solely on the list summary.
3. The coloured action buttons (Run, Stop, Delete, Create, etc.) are removed from the TUI screens (Jobs, Nodes, Credentials) to simplify the interface and rely on keyboard bindings.

## Tech Stack
- Textual (Python TUI framework)
- SQLite (Caching/Resource Tracking)

## File Structure
Changes are isolated to the TUI layer:
- `cb/tui/screens/jobs_screen.py`
- `cb/tui/screens/nodes_screen.py`
- `cb/tui/screens/credentials_screen.py`

## Task Breakdown

### Task 1: Fix Mine/All Profile Name Bug
- **Agent**: `backend-specialist`
- **Skills**: `clean-code`
- **INPUT**: Current `jobs_screen.py`, `nodes_screen.py`, `credentials_screen.py` where `profile = getattr(self.app, "_username", "")`.
- **OUTPUT**: Profile correctly resolves to `"default"` (or the active `CB_PROFILE`) instead of the `_username`, matching how CLI saves tracked resources.
- **VERIFY**: Switch to "Mine" tab and verify it shows tracked items.

### Task 2: Update Detail Screen Loading
- **Agent**: `frontend-specialist`
- **Skills**: `clean-code`
- **INPUT**: `action_open_detail()` methods in TUI screens.
- **OUTPUT**: Ensure they trigger a fresh database/API read (`get_job`, `get_node`, `get_credential`) rather than just passing the list DTO.
- **VERIFY**: Detail screen displays complete and up-to-date data.

### Task 3: Simplify Action Buttons (Remove color/Action Bar)
- **Agent**: `frontend-specialist`
- **Skills**: `clean-code`
- **INPUT**: TUI screens with `Horizontal(id="*-action-bar")`.
- **OUTPUT**: Remove the action bar completely to simplify UI, as bindkeys (r, s, l, n, d) are sufficient. Update the header hints if necessary.
- **VERIFY**: Visual inspection confirms no colored buttons; key bindings still work.

## Phase X: Verification
- [x] Task 1 Check: Run `bee --ui`, create a job/node, toggle to "Mine" and verify it appears.
- [x] Task 2 Check: Press Enter on an item, verify it loads missing details not on the list.
- [x] Task 3 Check: Verify action buttons are gone.
- [x] Code Lint: Run `make lint` or flake8.
- [x] Review Socratic Gate and Purple rules compliance.

## ✅ PHASE X COMPLETE
- Lint: [x] Pass
- Build: [x] Pass
- Date: 2026-03-27
